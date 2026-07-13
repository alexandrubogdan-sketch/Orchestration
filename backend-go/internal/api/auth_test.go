package api

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// This file ports test/unit/auth.test.ts's generateApiToken/hashApiToken
// cases. Both functions are pure aside from crypto/rand.Read, so no
// fakes/live DB are needed — the same "narrow enough to test without
// infrastructure" property the TS suite itself relies on.

func TestGenerateAPIToken_HasStablePrefix(t *testing.T) {
	raw, _, err := GenerateAPIToken()
	if err != nil {
		t.Fatalf("GenerateAPIToken returned error: %v", err)
	}
	if !strings.HasPrefix(raw, "po_") {
		t.Errorf("raw = %q, want prefix po_", raw)
	}
	if len(raw) <= 20 {
		t.Errorf("len(raw) = %d, want > 20", len(raw))
	}
}

func TestGenerateAPIToken_DifferentOnEveryCall(t *testing.T) {
	rawA, hashA, err := GenerateAPIToken()
	if err != nil {
		t.Fatalf("GenerateAPIToken returned error: %v", err)
	}
	rawB, hashB, err := GenerateAPIToken()
	if err != nil {
		t.Fatalf("GenerateAPIToken returned error: %v", err)
	}
	if rawA == rawB {
		t.Error("two calls to GenerateAPIToken produced the same raw token")
	}
	if hashA == hashB {
		t.Error("two calls to GenerateAPIToken produced the same hash")
	}
}

func TestHashAPIToken_DeterministicForSameInput(t *testing.T) {
	if HashAPIToken("po_abc123") != HashAPIToken("po_abc123") {
		t.Error("HashAPIToken is not deterministic for identical input")
	}
}

func TestHashAPIToken_NeverReturnsRawInput(t *testing.T) {
	raw := "po_super_secret_value"
	hash := HashAPIToken(raw)
	if hash == raw {
		t.Error("HashAPIToken returned the raw input unchanged")
	}
	if strings.Contains(hash, raw) {
		t.Error("HashAPIToken's output contains the raw input")
	}
}

func TestGenerateAPIToken_HashMatchesHashAPIToken(t *testing.T) {
	raw, hash, err := GenerateAPIToken()
	if err != nil {
		t.Fatalf("GenerateAPIToken returned error: %v", err)
	}
	if HashAPIToken(raw) != hash {
		t.Error("GenerateAPIToken's returned hash does not match HashAPIToken(raw)")
	}
}

// fakeTokenStoreWithErr is a minimal TokenStore whose Lookup always
// returns the configured (row, err) pair — enough to drive
// AuthMiddleware.Middleware's error-handling branches without a live
// Postgres.
type fakeTokenStoreWithErr struct {
	row TokenRow
	err error
}

func (s fakeTokenStoreWithErr) Lookup(context.Context, string) (TokenRow, error) {
	return s.row, s.err
}

func newTestHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

// Regression test for the backend review's confirmed bug (2026-07-10):
// AuthMiddleware.Middleware used to map every TokenStore.Lookup error —
// not just ErrTokenNotFound — to 401, so a transient DB failure (a
// dropped connection, a timeout) was indistinguishable from "this
// caller's token is invalid," and nothing was ever logged about it.
func TestAuthMiddleware_TokenNotFoundReturns401NoLog(t *testing.T) {
	var logBuf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuf, nil))

	mw := NewAuthMiddleware(AuthDeps{
		Tokens: fakeTokenStoreWithErr{err: ErrTokenNotFound},
		Logger: logger,
	})

	req := httptest.NewRequest(http.MethodGet, "/v1/payments", nil)
	req.Header.Set("Authorization", "Bearer po_somevalidlookingtoken")
	rec := httptest.NewRecorder()

	mw.Middleware(newTestHandler()).ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
	if logBuf.Len() != 0 {
		t.Errorf("expected nothing logged for an ordinary not-found token, got: %s", logBuf.String())
	}
}

func TestAuthMiddleware_TransientLookupErrorReturns500AndLogs(t *testing.T) {
	var logBuf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuf, nil))

	transientErr := errors.New("dial tcp: connection refused")
	mw := NewAuthMiddleware(AuthDeps{
		Tokens: fakeTokenStoreWithErr{err: transientErr},
		Logger: logger,
	})

	req := httptest.NewRequest(http.MethodGet, "/v1/payments", nil)
	req.Header.Set("Authorization", "Bearer po_somevalidlookingtoken")
	rec := httptest.NewRecorder()

	mw.Middleware(newTestHandler()).ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d — a transient lookup failure must not look like an invalid token", rec.Code, http.StatusInternalServerError)
	}
	if !bytes.Contains(logBuf.Bytes(), []byte("token lookup failed")) {
		t.Errorf("expected the transient error to be logged, got: %s", logBuf.String())
	}
	if !bytes.Contains(logBuf.Bytes(), []byte(transientErr.Error())) {
		t.Errorf("expected the underlying error to appear in the log line, got: %s", logBuf.String())
	}
}

func TestAuthMiddleware_ValidTokenSucceeds(t *testing.T) {
	mw := NewAuthMiddleware(AuthDeps{
		Tokens: fakeTokenStoreWithErr{row: TokenRow{ID: "tok_1", ProductID: "prod_1", MerchantEntityID: "me_1", Scope: "read_write"}},
	})

	req := httptest.NewRequest(http.MethodGet, "/v1/payments", nil)
	req.Header.Set("Authorization", "Bearer po_somevalidlookingtoken")
	rec := httptest.NewRecorder()

	var sawAuth AuthContext
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth, _ := authFromContext(r.Context())
		sawAuth = auth
		w.WriteHeader(http.StatusOK)
	})

	mw.Middleware(handler).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if sawAuth.ProductID != "prod_1" {
		t.Errorf("ProductID = %q, want prod_1", sawAuth.ProductID)
	}
}

func TestAuthMiddleware_MissingAuthorizationHeaderReturns401(t *testing.T) {
	mw := NewAuthMiddleware(AuthDeps{Tokens: fakeTokenStoreWithErr{}})

	req := httptest.NewRequest(http.MethodGet, "/v1/payments", nil)
	rec := httptest.NewRecorder()

	mw.Middleware(newTestHandler()).ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}
