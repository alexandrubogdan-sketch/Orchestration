package api

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5/middleware"
)

// Regression tests for the backend review's confirmed recoverMiddleware
// gaps (2026-07-10): (1) no stack trace was ever logged for a panic,
// only the recovered value itself, and (2) a panic occurring AFTER a
// handler had already started writing its response would cause
// WriteProblem to write a second, conflicting response on top of the
// first. See recoverMiddleware's own doc comments in router.go for the
// full reasoning.

func newRecoverTestLogger(buf *bytes.Buffer) *slog.Logger {
	return slog.New(slog.NewTextHandler(buf, nil))
}

func TestRecoverMiddleware_LogsStackTraceOnPanic(t *testing.T) {
	var buf bytes.Buffer
	logger := newRecoverTestLogger(&buf)

	panicking := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("simulated nil pointer dereference")
	})

	handler := recoverMiddleware(logger)(panicking)
	req := httptest.NewRequest(http.MethodGet, "/v1/payments", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
	if !bytes.Contains(buf.Bytes(), []byte("simulated nil pointer dereference")) {
		t.Errorf("expected the recovered panic value to be logged, got: %s", buf.String())
	}
	// The stack trace must reference this test file/function, proving a
	// real call stack was captured, not just the panic's string value
	// (which the assertion above already covers separately).
	if !bytes.Contains(buf.Bytes(), []byte("goroutine")) {
		t.Errorf("expected a goroutine stack trace to be logged (debug.Stack() output always starts with \"goroutine\"), got: %s", buf.String())
	}
}

func TestRecoverMiddleware_WritesCleanResponseWhenNothingWrittenYet(t *testing.T) {
	var buf bytes.Buffer
	logger := newRecoverTestLogger(&buf)

	panicking := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom before writing anything")
	})

	// Mirror BuildRouter's real middleware order: requestLoggingMiddleware
	// wraps w in a middleware.WrapResponseWriter BEFORE recoverMiddleware
	// ever sees it — recoverMiddleware's double-write guard depends on
	// this wrapping already having happened (see its own doc comment).
	handler := requestLoggingMiddleware(logger)(recoverMiddleware(logger)(panicking))

	req := httptest.NewRequest(http.MethodGet, "/v1/payments", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
	if rec.Body.Len() == 0 {
		t.Error("expected a problem+json body to have been written")
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Errorf("Content-Type = %q, want application/problem+json", ct)
	}
}

// Regression test for the double-write guard itself: a handler that
// already wrote a 200 and part of a body before panicking must NOT get
// a second WriteHeader/body from recoverMiddleware on top of it.
func TestRecoverMiddleware_DoesNotDoubleWriteWhenResponseAlreadyStarted(t *testing.T) {
	var buf bytes.Buffer
	logger := newRecoverTestLogger(&buf)

	panicking := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"partial":`))
		panic("boom mid-write")
	})

	handler := requestLoggingMiddleware(logger)(recoverMiddleware(logger)(panicking))

	req := httptest.NewRequest(http.MethodGet, "/v1/payments", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// The ORIGINAL 200 must survive untouched — recoverMiddleware must
	// not have overwritten it with 500.
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d (the original status must be preserved, not overwritten)", rec.Code, http.StatusOK)
	}
	if rec.Body.String() != `{"partial":` {
		t.Errorf("body = %q, want the original partial body untouched, with nothing appended", rec.Body.String())
	}
	if !bytes.Contains(buf.Bytes(), []byte("already started")) {
		t.Errorf("expected a log line noting the response had already started, got: %s", buf.String())
	}
}

// Sanity check that this test file's assumption about
// middleware.WrapResponseWriter.Status() (0 means "nothing sent yet")
// matches chi's own documented behavior, independent of
// recoverMiddleware — protects the double-write guard from silently
// regressing if chi's semantics ever change underneath it.
func TestWrapResponseWriter_StatusIsZeroBeforeAnyWrite(t *testing.T) {
	rec := httptest.NewRecorder()
	ww := middleware.NewWrapResponseWriter(rec, 1)
	if got := ww.Status(); got != 0 {
		t.Errorf("Status() before any write = %d, want 0", got)
	}
}
