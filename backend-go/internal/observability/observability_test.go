package observability

import (
	"context"
	"testing"
)

func TestNewLogger_DoesNotPanic(t *testing.T) {
	logger := NewLogger(LoggerConfig{LogLevel: "info", ServiceName: "test-service", Env: "test"})
	if logger == nil {
		t.Fatal("NewLogger returned nil")
	}
	logger.Info("test message", "key", "value")
}

func TestParseLevel_MapsEveryKnownLogLevel(t *testing.T) {
	levels := []string{"fatal", "error", "warn", "info", "debug", "trace", "silent"}
	for _, l := range levels {
		// Must not panic for any recognized LOG_LEVEL value.
		_ = parseLevel(l)
	}
}

func TestStartTracing_InitializesWithoutError(t *testing.T) {
	shutdown, err := StartTracing(TracerConfig{ServiceName: "test-service"})
	if err != nil {
		t.Fatalf("StartTracing error: %v", err)
	}
	if shutdown == nil {
		t.Fatal("StartTracing returned nil shutdown func")
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown error: %v", err)
	}
}

// Regression tests for the backend review's confirmed double-call gap
// (2026-07-10): a second StartTracing call before the first one's
// Shutdown ran used to silently replace the global TracerProvider,
// orphaning the first one with no error or warning of any kind.
func TestStartTracing_SecondCallWithoutShutdownReturnsError(t *testing.T) {
	shutdown, err := StartTracing(TracerConfig{ServiceName: "test-service-a"})
	if err != nil {
		t.Fatalf("first StartTracing error: %v", err)
	}
	defer func() { _ = shutdown(context.Background()) }()

	_, err = StartTracing(TracerConfig{ServiceName: "test-service-b"})
	if err == nil {
		t.Fatal("expected an error from a second StartTracing call before the first Shutdown ran, got nil")
	}
}

func TestStartTracing_CanRestartAfterShutdown(t *testing.T) {
	shutdown, err := StartTracing(TracerConfig{ServiceName: "test-service-c"})
	if err != nil {
		t.Fatalf("first StartTracing error: %v", err)
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown error: %v", err)
	}

	shutdown2, err := StartTracing(TracerConfig{ServiceName: "test-service-d"})
	if err != nil {
		t.Fatalf("StartTracing after Shutdown should succeed, got error: %v", err)
	}
	if err := shutdown2(context.Background()); err != nil {
		t.Fatalf("second shutdown error: %v", err)
	}
}

func TestGetTracer_ReturnsNonNilTracer(t *testing.T) {
	tracer := GetTracer("test")
	if tracer == nil {
		t.Fatal("GetTracer returned nil")
	}
}

func TestRegistry_HasRegisteredMetrics(t *testing.T) {
	families, err := Registry.Gather()
	if err != nil {
		t.Fatalf("Registry.Gather() error: %v", err)
	}
	if len(families) == 0 {
		t.Fatal("expected at least one registered metric family")
	}

	found := map[string]bool{}
	for _, f := range families {
		found[f.GetName()] = true
	}
	for _, want := range []string{"http_request_duration_seconds", "payments_unmapped_decline_code_total"} {
		if !found[want] {
			t.Errorf("metric family %q not found in registry", want)
		}
	}
}
