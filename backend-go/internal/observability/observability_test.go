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
