package observability

import (
	"context"
	"fmt"
	"sync"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// tracingState guards StartTracing against being called twice without
// an intervening Shutdown — see StartTracing's own BUG FIX doc comment
// for why this exists.
var tracingState struct {
	mu      sync.Mutex
	started bool
}

// TracerConfig is the minimal subset of application config the tracer
// setup needs — mirrors the TS tracer.ts's
// Pick<AppConfig, 'otel'> parameter.
type TracerConfig struct {
	ServiceName          string
	ExporterOTLPEndpoint string // empty means "no real exporter configured yet"
}

// StartTracing initializes a minimal OTel SDK tracer provider and
// registers it as the global tracer provider, mirroring the TS
// tracer.ts's startTracing() call-once-at-boot contract.
//
// THIS IS A STUB (foundation phase only): it wires up a real
// sdktrace.TracerProvider with a Resource carrying the service name,
// but registers NO span exporter/processor — spans are created and
// dropped, not shipped anywhere, whether or not
// OTEL_EXPORTER_OTLP_ENDPOINT is set. A later phase must:
//   - add a real OTLP exporter
//     (go.opentelemetry.io/otel/exporters/otlp/otlptrace) wired to
//     TracerConfig.ExporterOTLPEndpoint, and
//   - add the per-library auto-instrumentation the TS version gets for
//     free from @opentelemetry/auto-instrumentations-node (pg, redis,
//     http). Go has no single equivalent "auto-instrument everything"
//     package — each instrumentation (pgx, go-redis, net/http, chi)
//     must be added individually via go.opentelemetry.io/contrib/....
//
// Returns a shutdown function the caller should defer/call on process
// exit (mirrors the TS version's SIGTERM/SIGINT shutdown hooks, made
// explicit here rather than installed as signal handlers, so cmd/*
// controls its own signal-handling policy).
//
// BUG FIX (backend review, 2026-07-10): double-call guard. This used
// to unconditionally call otel.SetTracerProvider(tp), which replaces
// process-wide GLOBAL state with no check for whether tracing was
// already started. A second call anywhere in the same process (a
// future code path added to cmd/api or cmd/worker's boot sequence, a
// retry-on-partial-boot-failure path, or simply two test functions in
// this package's own test suite both calling StartTracing) would
// silently swap in a brand-new TracerProvider and ORPHAN the first one
// — its shutdown func, if still held by the original caller, would
// then be shutting down a TracerProvider that isn't even the global
// one anymore (harmless in itself, since that provider is just
// dropping spans either way per this stub's own doc comment, but the
// double-init itself is exactly the kind of state-management bug that
// gets silently papered over here today, then bites hard once a real
// exporter/processor is added later and now-orphaned providers are
// each holding their own live exporter connection). Fixed by tracking
// whether tracing is currently started and refusing a second
// StartTracing call until the first one's Shutdown has run — Shutdown
// clears the guard, so a legitimate restart-after-shutdown sequence
// (e.g. this package's own test suite calling StartTracing, then
// Shutdown, then StartTracing again in a different test) still works.
func StartTracing(cfg TracerConfig) (shutdown func(context.Context) error, err error) {
	tracingState.mu.Lock()
	if tracingState.started {
		tracingState.mu.Unlock()
		return nil, fmt.Errorf("observability: StartTracing called while tracing is already started in this process — call the previous Shutdown first")
	}
	tracingState.started = true
	tracingState.mu.Unlock()

	// On any error return below, release the guard we just took —
	// otherwise a failed StartTracing call would permanently wedge this
	// process out of ever starting tracing at all.
	releaseGuardOnError := func() {
		tracingState.mu.Lock()
		tracingState.started = false
		tracingState.mu.Unlock()
	}

	res, err := resource.Merge(
		resource.Default(),
		resource.NewSchemaless(
			attribute.String("service.name", cfg.ServiceName),
		),
	)
	if err != nil {
		releaseGuardOnError()
		return nil, fmt.Errorf("observability: failed to build otel resource: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		// No span processor/exporter registered yet — see doc comment.
	)
	otel.SetTracerProvider(tp)

	return func(ctx context.Context) error {
		tracingState.mu.Lock()
		tracingState.started = false
		tracingState.mu.Unlock()
		return tp.Shutdown(ctx)
	}, nil
}

// GetTracer returns a named tracer from the global tracer provider,
// mirroring the TS tracer.ts's getTracer(name).
func GetTracer(name string) trace.Tracer {
	return otel.Tracer(name)
}
