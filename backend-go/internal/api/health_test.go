package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

// fakePinger is a minimal PostgresPinger/RedisPinger fake — both
// interfaces have the identical Ping(ctx) error shape, so one fake
// type serves both without a live Postgres/Redis, exactly as the task
// brief asks: "define small interfaces you can fake — don't require a
// live DB/Redis in tests."
type fakePinger struct {
	err error
}

func (p fakePinger) Ping(ctx context.Context) error { return p.err }

func newTestHealthMux(deps HealthDeps) *chi.Mux {
	mux := chi.NewRouter()
	registerHealthRoutes(mux, deps)
	return mux
}

func doGet(t *testing.T, mux http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestHealthz_AlwaysReturns200RegardlessOfDependencies(t *testing.T) {
	// /healthz must never touch Postgres/Redis at all — verified here by
	// wiring pingers that would fail if called, and confirming the
	// response is still a clean 200.
	deps := HealthDeps{
		Postgres: fakePinger{err: errors.New("postgres is down")},
		Redis:    fakePinger{err: errors.New("redis is down")},
	}
	mux := newTestHealthMux(deps)

	rec := doGet(t, mux, "/healthz")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "ok" {
		t.Errorf(`body["status"] = %q, want "ok"`, body["status"])
	}
}

func TestReadyz_BothDependenciesHealthy(t *testing.T) {
	deps := HealthDeps{
		Postgres: fakePinger{err: nil},
		Redis:    fakePinger{err: nil},
	}
	mux := newTestHealthMux(deps)

	rec := doGet(t, mux, "/readyz")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var body readyResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Status != "ready" {
		t.Errorf("Status = %q, want %q", body.Status, "ready")
	}
	if body.Checks.Postgres != dependencyStatusOK {
		t.Errorf("Checks.Postgres = %q, want %q", body.Checks.Postgres, dependencyStatusOK)
	}
	if body.Checks.Redis != dependencyStatusOK {
		t.Errorf("Checks.Redis = %q, want %q", body.Checks.Redis, dependencyStatusOK)
	}
}

func TestReadyz_PostgresDown(t *testing.T) {
	deps := HealthDeps{
		Postgres: fakePinger{err: errors.New("connection refused")},
		Redis:    fakePinger{err: nil},
	}
	mux := newTestHealthMux(deps)

	rec := doGet(t, mux, "/readyz")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}

	var body readyResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Status != "not_ready" {
		t.Errorf("Status = %q, want %q", body.Status, "not_ready")
	}
	if body.Checks.Postgres != dependencyStatusError {
		t.Errorf("Checks.Postgres = %q, want %q (the specific failing dependency must be named)", body.Checks.Postgres, dependencyStatusError)
	}
	if body.Checks.Redis != dependencyStatusOK {
		t.Errorf("Checks.Redis = %q, want %q (a healthy dependency must not be masked as failing)", body.Checks.Redis, dependencyStatusOK)
	}
}

func TestReadyz_RedisDown(t *testing.T) {
	deps := HealthDeps{
		Postgres: fakePinger{err: nil},
		Redis:    fakePinger{err: errors.New("NOAUTH")},
	}
	mux := newTestHealthMux(deps)

	rec := doGet(t, mux, "/readyz")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}

	var body readyResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Checks.Redis != dependencyStatusError {
		t.Errorf("Checks.Redis = %q, want %q", body.Checks.Redis, dependencyStatusError)
	}
	if body.Checks.Postgres != dependencyStatusOK {
		t.Errorf("Checks.Postgres = %q, want %q", body.Checks.Postgres, dependencyStatusOK)
	}
}

func TestReadyz_BothDependenciesDown(t *testing.T) {
	deps := HealthDeps{
		Postgres: fakePinger{err: errors.New("timeout")},
		Redis:    fakePinger{err: errors.New("timeout")},
	}
	mux := newTestHealthMux(deps)

	rec := doGet(t, mux, "/readyz")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}

	var body readyResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Checks.Postgres != dependencyStatusError || body.Checks.Redis != dependencyStatusError {
		t.Errorf("expected both checks to report error, got postgres=%q redis=%q", body.Checks.Postgres, body.Checks.Redis)
	}
}
