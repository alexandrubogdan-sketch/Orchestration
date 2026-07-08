// Command worker is the payment-orchestrator background worker
// process.
//
// PHASE 7 (this file): UPDATED from every prior phase's placeholder
// (which loaded config, logged "ready," and exited with no Hatchet
// client, no task handlers, no metrics server) to a real boot sequence:
// load config, connect Postgres/Redis, build the Hatchet client from
// HATCHET_CLIENT_TOKEN/HATCHET_CLIENT_TLS_STRATEGY, register every task
// + cron from internal/worker, start the worker, and run the same tiny
// /metrics + /healthz HTTP server worker.ts runs on its own bare
// http.createServer (the worker has no Fastify/chi instance — see that
// file's bottom section, mirrored here 1:1 with Go's net/http).
//
// Boot ordering mirrors cmd/api/main.go's own documented discipline
// (see that file's top doc comment for the full "why," reproduced in
// summary here): pgxpool.New/redis.NewClient both construct lazily (no
// network round-trip at construction time), and the metrics HTTP
// listener binds via a goroutine so a slow/failed Hatchet connection
// does not prevent /healthz from being reachable on the worker's own
// metrics port. Unlike the API process, THIS process's core job (running
// Hatchet-dispatched tasks) does genuinely depend on a live Hatchet
// connection to do anything useful — worker.Start() blocking below is
// therefore an intentional, unavoidable dependency, not the same
// "avoid blocking the listener" bug class cmd/api/main.go's own doc
// comment warns against; the metrics server binds BEFORE that blocking
// call specifically so /healthz stays reachable even while
// worker.Start() blocks.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	hatchet "github.com/hatchet-dev/hatchet/sdks/go"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"

	"github.com/alphapayments/payment-orchestrator/internal/adapters/registry"
	"github.com/alphapayments/payment-orchestrator/internal/adapters/solidgate"
	"github.com/alphapayments/payment-orchestrator/internal/adapters/stripe"
	"github.com/alphapayments/payment-orchestrator/internal/api"
	"github.com/alphapayments/payment-orchestrator/internal/config"
	"github.com/alphapayments/payment-orchestrator/internal/observability"
	"github.com/alphapayments/payment-orchestrator/internal/webhooks"
	"github.com/alphapayments/payment-orchestrator/internal/worker"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "worker: configuration error:")
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}

	logger := observability.NewLogger(observability.LoggerConfig{
		LogLevel:    cfg.LogLevel,
		ServiceName: cfg.ServiceName,
		Env:         cfg.Env,
	})

	shutdownTracing, err := observability.StartTracing(observability.TracerConfig{
		ServiceName:          cfg.Otel.ServiceName,
		ExporterOTLPEndpoint: cfg.Otel.ExporterOTLPEndpoint,
	})
	if err != nil {
		logger.Error("failed to start tracing", "error", err)
		os.Exit(1)
	}
	defer func() {
		_ = shutdownTracing(context.Background())
	}()

	// pgxpool.New / redis.NewClient both construct their pool/client
	// lazily — see cmd/api/main.go's identical note; the same reasoning
	// applies here even though this process's actual task handlers WILL
	// perform real round-trips almost immediately once tasks start
	// running.
	pgPool, err := pgxpool.New(context.Background(), cfg.Database.URL)
	if err != nil {
		logger.Error("failed to construct postgres pool", "error", err)
		os.Exit(1)
	}
	defer pgPool.Close()

	redisOpts, err := redis.ParseURL(cfg.Redis.URL)
	if err != nil {
		logger.Error("failed to parse REDIS_URL", "error", err)
		os.Exit(1)
	}
	redisClient := redis.NewClient(redisOpts)
	defer redisClient.Close()
	_ = redisClient // reserved: see this file's own doc comment in a future phase if a worker task needs Redis directly (none does as of Phase 7 — routing/rate-limiting concerns belong to the API process's outbound PSP calls, not this worker's).

	// Same registry construction as cmd/api/main.go — mock is always
	// usable immediately; Stripe/Solidgate credentials resolve lazily
	// per psp_account inside Resolve. declineMaps is empty for the exact
	// same reason cmd/api/main.go's is: no DB-backed
	// decline_code_map-loading call site exists anywhere in this Go
	// port yet (see that file's own doc comment).
	pspRegistry := registry.New(registry.Config{
		Stripe: stripe.ConfigCredentials{
			Mode:           cfg.Stripe.Mode,
			SecretKey:      cfg.Stripe.SecretKey,
			PublishableKey: cfg.Stripe.PublishableKey,
			WebhookSecret:  cfg.Stripe.WebhookSecret,
			APIVersion:     cfg.Stripe.APIVersion,
		},
		Solidgate: solidgate.ConfigCredentials{
			Mode:             cfg.Solidgate.Mode,
			PublicKey:        cfg.Solidgate.PublicKey,
			SecretKey:        cfg.Solidgate.SecretKey,
			WebhookPublicKey: cfg.Solidgate.WebhookPublicKey,
			WebhookSecretKey: cfg.Solidgate.WebhookSecretKey,
			APIBaseURL:       cfg.Solidgate.APIBaseURL,
		},
	}, nil)

	webhookDeps := webhooks.Deps{
		Pool:       pgPool,
		Registry:   pspRegistry,
		Metrics:    webhooks.PrometheusMetrics{},
		StableName: api.StableName,
	}

	// Hatchet client construction. hatchet.NewClient() reads
	// HATCHET_CLIENT_TOKEN (and HATCHET_CLIENT_TLS_STRATEGY) from the
	// process environment AUTOMATICALLY — confirmed directly against
	// Hatchet's own Go SDK documentation (see MIGRATION_NOTES.md's
	// Phase 7 section for the exact confirmation), which is why no
	// explicit token/TLS option is threaded through here from
	// cfg.Hatchet.Token/cfg.Hatchet.TLSStrategy: those two
	// internal/config.Config fields exist so config.Load() can validate
	// HATCHET_CLIENT_TOKEN is present (`required,min=1`) and
	// HATCHET_CLIENT_TLS_STRATEGY is one of none/tls/mtls BEFORE this
	// process gets anywhere near constructing a Hatchet client — by the
	// time NewClient() is called below, those exact same two env vars
	// are already known-good, and hatchet.NewClient() reads them itself
	// from os.Environ() the same way config.Load() already did. This
	// deliberately avoids guessing at an unverified
	// programmatic-token-override option name (e.g. a hypothetical
	// hatchet.WithToken(...)) that this sandbox had no way to confirm
	// exists with that exact spelling — see this port's self-critical
	// list in MIGRATION_NOTES.md for this exact uncertainty named
	// explicitly. If a future phase needs to override the token
	// programmatically (e.g. per-tenant multi-token setups), that is the
	// place to add and verify the real option name against a live
	// `go doc` run, not guess it here.
	hatchetClient, err := hatchet.NewClient()
	if err != nil {
		logger.Error("failed to construct hatchet client", "error", err)
		os.Exit(1)
	}

	deps := worker.Deps{
		Pool:     pgPool,
		Registry: pspRegistry,
		Webhooks: webhookDeps,
		Logger:   logger,
	}

	// Register every task + the exact 7 TS-sourced cron schedules —
	// see internal/worker/cron.go's own top doc comment for exactly how
	// cron attachment maps from worker.ts's separate
	// workflowEngine.cron(...) calls to this SDK's registration-time
	// hatchet.WithWorkflowCron(...) option.
	// SetDispatcher must run AFTER RegisterAllWithCrons: it builds a
	// task-name -> *hatchet.StandaloneTask lookup from the returned Tasks
	// value (RunNoWait is a method on the concrete task object per
	// docs.hatchet.run/v1/running-your-task, not a dispatch-by-name-string
	// method on *hatchet.Client — see tasks.go's SetDispatcher doc comment
	// for the full correction history), so the tasks must already exist
	// before the dispatcher can reference them.
	tasks := worker.RegisterAllWithCrons(hatchetClient, deps)
	worker.SetDispatcher(tasks)

	hatchetWorker, err := hatchetClient.NewWorker("payment-orchestrator-worker",
		hatchet.WithWorkflows(tasks.All()...),
	)
	if err != nil {
		logger.Error("failed to construct hatchet worker", "error", err)
		os.Exit(1)
	}

	// The worker has no Fastify/chi instance; expose /metrics and
	// /healthz on its own tiny HTTP server, mirroring worker.ts's bare
	// http.createServer 1:1 (same two routes, same 404-everything-else
	// fallback, same "listen, then log the bound port" sequence).
	metricsMux := http.NewServeMux()
	metricsMux.Handle("/metrics", promhttp.HandlerFor(observability.Registry, promhttp.HandlerOpts{}))
	metricsMux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	metricsMux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})

	metricsAddr := fmt.Sprintf(":%d", cfg.Metrics.Port)
	metricsServer := &http.Server{Addr: metricsAddr, Handler: metricsMux}

	go func() {
		logger.Info("worker metrics server listening", "port", cfg.Metrics.Port)
		if err := metricsServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("worker metrics server error", "error", err)
		}
	}()

	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGTERM, syscall.SIGINT)

	// CORRECTED (2026-07-08, against the first real build's own compile
	// error): *hatchet.Worker has no Stop() method — confirmed from
	// sdks/go/client.go's own source, which only exposes Start() (returns
	// a cleanup func) and StartBlocking(ctx) (blocks until ctx.Done(),
	// then runs that same cleanup internally before returning). The
	// correct shutdown shape is therefore to cancel the context passed to
	// StartBlocking and wait for it to return, not to call a separate
	// Stop method from outside.
	workerCtx, cancelWorker := context.WithCancel(context.Background())
	defer cancelWorker()

	workerErrCh := make(chan error, 1)
	go func() {
		logger.Info("worker starting, awaiting tasks")
		workerErrCh <- hatchetWorker.StartBlocking(workerCtx)
	}()

	select {
	case sig := <-shutdown:
		logger.Info("shutting down worker", "signal", sig.String())
		cancelWorker()
		if err := <-workerErrCh; err != nil {
			logger.Error("error stopping hatchet worker", "error", err)
		}
	case err := <-workerErrCh:
		if err != nil {
			logger.Error("hatchet worker exited with error", "error", err)
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := metricsServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("error during metrics server graceful shutdown", "error", err)
	}
}
