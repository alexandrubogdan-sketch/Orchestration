package observability

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

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
func StartTracing(cfg TracerConfig) (shutdown func(context.Context) error, err error) {
	res, err := resource.Merge(
		resource.Default(),
		resource.NewSchemaless(
			attribute.String("service.name", cfg.ServiceName),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("observability: failed to build otel resource: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		// No span processor/exporter registered yet — see doc comment.
	)
	otel.SetTracerProvider(tp)

	return tp.Shutdown, nil
}

// GetTracer returns a named tracer from the global tracer provider,
// mirroring the TS tracer.ts's getTracer(name).
func GetTracer(name string) trace.Tracer {
	return otel.Tracer(name)
}
