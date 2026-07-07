package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

// This file covers the retry_settings resource end-to-end against an
// in-memory fake store — no live Postgres, matching this package's
// established testing convention (see checkout_sessions_test.go's
// fakeCheckoutSessionsStore, the closest existing precedent for a
// small, resource-scoped fake store; testAuthContext/withTestAuth are
// reused directly from checkout_sessions_test.go rather than
// redeclared here).

// fakeRetrySettingsStore is a minimal in-memory RetrySettingsStore.
type fakeRetrySettingsStore struct {
	mu   sync.Mutex
	rows map[string]RetrySettingsRow // keyed by merchantEntityID
}

func newFakeRetrySettingsStore() *fakeRetrySettingsStore {
	return &fakeRetrySettingsStore{rows: make(map[string]RetrySettingsRow)}
}

func (s *fakeRetrySettingsStore) GetRetrySettings(_ context.Context, merchantEntityID string) (RetrySettingsRow, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row, ok := s.rows[merchantEntityID]
	return row, ok, nil
}

// UpsertRetrySettings mirrors PgxPaymentsStore.UpsertRetrySettings'
// INSERT ... ON CONFLICT DO UPDATE semantics: the first call for a
// given merchant entity creates the row, every subsequent call
// overwrites it in place — same merchant_entity_id, fresh UpdatedAt.
func (s *fakeRetrySettingsStore) UpsertRetrySettings(_ context.Context, merchantEntityID string, input UpsertRetrySettingsInput) (RetrySettingsRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row := RetrySettingsRow{
		MerchantEntityID:      merchantEntityID,
		DunningLadderHours:    input.DunningLadderHours,
		MaxAttemptsPerPayment: input.MaxAttemptsPerPayment,
		MinSpacingSeconds:     input.MinSpacingSeconds,
		UpdatedAt:             time.Now(),
	}
	s.rows[merchantEntityID] = row
	return row, nil
}

func newRetrySettingsRequest(t *testing.T, method string, bodyJSON string, auth AuthContext) *http.Request {
	t.Helper()
	var req *http.Request
	if bodyJSON == "" {
		req = httptest.NewRequest(method, "/v1/retry-settings", nil)
	} else {
		req = httptest.NewRequest(method, "/v1/retry-settings", strings.NewReader(bodyJSON))
	}
	return withTestAuth(req, auth)
}

// TestGetRetrySettings_NoRowYet_ReturnsHardcodedDefaults verifies the
// "lazy row" behavior the task brief specifically asked for: a merchant
// entity that has never called PUT sees the exact same defaults the
// hardcoded internal/routing.DefaultRetryPolicy/
// internal/subscriptions.DunningLadderHours vars carried before this
// feature existed — 24/72/168 hour ladder, 3 max attempts, 2 second
// spacing — and, critically, this GET must NOT create a row (verified
// below by asserting the fake store stays empty).
func TestGetRetrySettings_NoRowYet_ReturnsHardcodedDefaults(t *testing.T) {
	store := newFakeRetrySettingsStore()
	deps := RetrySettingsRouteDeps{Store: store}
	auth := testAuthContext()

	req := newRetrySettingsRequest(t, http.MethodGet, "", auth)
	rec := httptest.NewRecorder()
	handleGetRetrySettings(deps)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"dunningLadderHours":[24,72,168]`) {
		t.Errorf("response missing default dunningLadderHours: %s", body)
	}
	if !strings.Contains(body, `"maxAttemptsPerPayment":3`) {
		t.Errorf("response missing default maxAttemptsPerPayment=3: %s", body)
	}
	if !strings.Contains(body, `"minSpacingSeconds":2`) {
		t.Errorf("response missing default minSpacingSeconds=2: %s", body)
	}

	store.mu.Lock()
	rowCount := len(store.rows)
	store.mu.Unlock()
	if rowCount != 0 {
		t.Errorf("GET must not create a row when none exists yet — fake store has %d rows, want 0", rowCount)
	}
}

// TestPutRetrySettings_FirstCall_CreatesRow verifies the other half of
// the "lazy row" contract: PUT is what actually creates the row, and
// the response reflects exactly what was sent.
func TestPutRetrySettings_FirstCall_CreatesRow(t *testing.T) {
	store := newFakeRetrySettingsStore()
	deps := RetrySettingsRouteDeps{Store: store}
	auth := testAuthContext()

	bodyJSON := `{"dunningLadderHours":[12,48,120],"maxAttemptsPerPayment":5,"minSpacingSeconds":10}`
	req := newRetrySettingsRequest(t, http.MethodPut, bodyJSON, auth)
	rec := httptest.NewRecorder()
	handleUpsertRetrySettings(deps)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"dunningLadderHours":[12,48,120]`) {
		t.Errorf("response missing the submitted dunningLadderHours: %s", body)
	}
	if !strings.Contains(body, `"maxAttemptsPerPayment":5`) {
		t.Errorf("response missing the submitted maxAttemptsPerPayment: %s", body)
	}
	if !strings.Contains(body, `"minSpacingSeconds":10`) {
		t.Errorf("response missing the submitted minSpacingSeconds: %s", body)
	}

	row, found, err := store.GetRetrySettings(context.Background(), auth.MerchantEntityID)
	if err != nil || !found {
		t.Fatalf("GetRetrySettings after PUT: found=%v err=%v", found, err)
	}
	if row.MaxAttemptsPerPayment != 5 {
		t.Errorf("stored MaxAttemptsPerPayment = %d, want 5", row.MaxAttemptsPerPayment)
	}
}

// TestGetRetrySettings_AfterPut_ReturnsStoredRow verifies GET reflects
// PUT's write — the two handlers agree on the same merchant entity's
// row once one exists.
func TestGetRetrySettings_AfterPut_ReturnsStoredRow(t *testing.T) {
	store := newFakeRetrySettingsStore()
	deps := RetrySettingsRouteDeps{Store: store}
	auth := testAuthContext()

	putBody := `{"dunningLadderHours":[6,24,72,168],"maxAttemptsPerPayment":4,"minSpacingSeconds":5}`
	putReq := newRetrySettingsRequest(t, http.MethodPut, putBody, auth)
	putRec := httptest.NewRecorder()
	handleUpsertRetrySettings(deps)(putRec, putReq)
	if putRec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, want 200; body = %s", putRec.Code, putRec.Body.String())
	}

	getReq := newRetrySettingsRequest(t, http.MethodGet, "", auth)
	getRec := httptest.NewRecorder()
	handleGetRetrySettings(deps)(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want 200; body = %s", getRec.Code, getRec.Body.String())
	}
	if !strings.Contains(getRec.Body.String(), `"dunningLadderHours":[6,24,72,168]`) {
		t.Errorf("GET after PUT missing the stored ladder: %s", getRec.Body.String())
	}
}

// TestPutRetrySettings_SecondCall_UpdatesInPlace verifies this is
// genuinely a singleton-per-merchant-entity row: a second PUT overwrites
// the first, it does not create a second row / error on conflict.
func TestPutRetrySettings_SecondCall_UpdatesInPlace(t *testing.T) {
	store := newFakeRetrySettingsStore()
	deps := RetrySettingsRouteDeps{Store: store}
	auth := testAuthContext()

	first := `{"dunningLadderHours":[24,72,168],"maxAttemptsPerPayment":3,"minSpacingSeconds":2}`
	req1 := newRetrySettingsRequest(t, http.MethodPut, first, auth)
	rec1 := httptest.NewRecorder()
	handleUpsertRetrySettings(deps)(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("first PUT status = %d, want 200", rec1.Code)
	}

	second := `{"dunningLadderHours":[1,2,3],"maxAttemptsPerPayment":10,"minSpacingSeconds":0}`
	req2 := newRetrySettingsRequest(t, http.MethodPut, second, auth)
	rec2 := httptest.NewRecorder()
	handleUpsertRetrySettings(deps)(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("second PUT status = %d, want 200; body = %s", rec2.Code, rec2.Body.String())
	}
	if !strings.Contains(rec2.Body.String(), `"maxAttemptsPerPayment":10`) {
		t.Errorf("second PUT response should reflect the NEW value: %s", rec2.Body.String())
	}

	store.mu.Lock()
	rowCount := len(store.rows)
	store.mu.Unlock()
	if rowCount != 1 {
		t.Errorf("expected exactly one row after two PUTs for the same merchant entity, got %d", rowCount)
	}
}

// TestPutRetrySettings_ScopedByMerchantEntity verifies two different
// merchant entities (two different Bearer tokens) each get their own
// independent row — retry policy is a per-merchant-entity setting, not
// global.
func TestPutRetrySettings_ScopedByMerchantEntity(t *testing.T) {
	store := newFakeRetrySettingsStore()
	deps := RetrySettingsRouteDeps{Store: store}

	authA := AuthContext{APITokenID: "tok_a", ProductID: uuid.Must(uuid.NewV7()).String(), MerchantEntityID: uuid.Must(uuid.NewV7()).String()}
	authB := AuthContext{APITokenID: "tok_b", ProductID: uuid.Must(uuid.NewV7()).String(), MerchantEntityID: uuid.Must(uuid.NewV7()).String()}

	bodyA := `{"dunningLadderHours":[1,2],"maxAttemptsPerPayment":2,"minSpacingSeconds":1}`
	reqA := newRetrySettingsRequest(t, http.MethodPut, bodyA, authA)
	recA := httptest.NewRecorder()
	handleUpsertRetrySettings(deps)(recA, reqA)
	if recA.Code != http.StatusOK {
		t.Fatalf("PUT for merchant A status = %d, want 200", recA.Code)
	}

	getReqB := newRetrySettingsRequest(t, http.MethodGet, "", authB)
	getRecB := httptest.NewRecorder()
	handleGetRetrySettings(deps)(getRecB, getReqB)
	if getRecB.Code != http.StatusOK {
		t.Fatalf("GET for merchant B status = %d, want 200", getRecB.Code)
	}
	if !strings.Contains(getRecB.Body.String(), `"dunningLadderHours":[24,72,168]`) {
		t.Errorf("merchant B (never configured) should still see hardcoded defaults, got: %s", getRecB.Body.String())
	}
}

// TestPutRetrySettings_ValidationErrors exercises
// validateRetrySettingsInput's contract: ladder length bounds, every
// entry non-negative, ascending order, maxAttemptsPerPayment >= 1,
// minSpacingSeconds >= 0.
func TestPutRetrySettings_ValidationErrors(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"empty ladder", `{"dunningLadderHours":[],"maxAttemptsPerPayment":3,"minSpacingSeconds":2}`},
		{"too many ladder entries", `{"dunningLadderHours":[1,2,3,4,5,6,7,8,9,10,11],"maxAttemptsPerPayment":3,"minSpacingSeconds":2}`},
		{"negative ladder entry", `{"dunningLadderHours":[24,-1,168],"maxAttemptsPerPayment":3,"minSpacingSeconds":2}`},
		{"non-ascending ladder", `{"dunningLadderHours":[72,24,168],"maxAttemptsPerPayment":3,"minSpacingSeconds":2}`},
		{"zero max attempts", `{"dunningLadderHours":[24,72,168],"maxAttemptsPerPayment":0,"minSpacingSeconds":2}`},
		{"negative max attempts", `{"dunningLadderHours":[24,72,168],"maxAttemptsPerPayment":-1,"minSpacingSeconds":2}`},
		{"negative min spacing", `{"dunningLadderHours":[24,72,168],"maxAttemptsPerPayment":3,"minSpacingSeconds":-1}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newFakeRetrySettingsStore()
			deps := RetrySettingsRouteDeps{Store: store}
			auth := testAuthContext()

			req := newRetrySettingsRequest(t, http.MethodPut, tc.body, auth)
			rec := httptest.NewRecorder()
			handleUpsertRetrySettings(deps)(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
			}

			store.mu.Lock()
			rowCount := len(store.rows)
			store.mu.Unlock()
			if rowCount != 0 {
				t.Errorf("a rejected PUT must not create a row — got %d rows", rowCount)
			}
		})
	}
}

// TestPutRetrySettings_AscendingAllowsEqualSteps verifies "ascending"
// means non-decreasing, not strictly increasing — a ladder with two
// equal consecutive delays (e.g. [24,24,72]) is a legitimate, if
// unusual, policy choice and must be accepted.
func TestPutRetrySettings_AscendingAllowsEqualSteps(t *testing.T) {
	store := newFakeRetrySettingsStore()
	deps := RetrySettingsRouteDeps{Store: store}
	auth := testAuthContext()

	bodyJSON := `{"dunningLadderHours":[24,24,72],"maxAttemptsPerPayment":3,"minSpacingSeconds":2}`
	req := newRetrySettingsRequest(t, http.MethodPut, bodyJSON, auth)
	rec := httptest.NewRecorder()
	handleUpsertRetrySettings(deps)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (equal consecutive steps should be accepted); body = %s", rec.Code, rec.Body.String())
	}
}

// TestGetRetrySettings_MissingAuth_Is401 and
// TestPutRetrySettings_MissingAuth_Is401 verify both handlers check for
// an auth context before doing anything else — matching every other
// /v1/* handler in this package's own expectation that authFromContext
// always succeeds when reached through the real authMW.Middleware
// chain, but failing safely (401, not a panic) if that invariant is
// ever violated (e.g. a handler invoked directly in a test without
// going through the middleware, exactly as this file's own other tests
// deliberately do via withTestAuth).
func TestGetRetrySettings_MissingAuth_Is401(t *testing.T) {
	store := newFakeRetrySettingsStore()
	deps := RetrySettingsRouteDeps{Store: store}

	req := httptest.NewRequest(http.MethodGet, "/v1/retry-settings", nil)
	rec := httptest.NewRecorder()
	handleGetRetrySettings(deps)(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body = %s", rec.Code, rec.Body.String())
	}
}

func TestPutRetrySettings_MissingAuth_Is401(t *testing.T) {
	store := newFakeRetrySettingsStore()
	deps := RetrySettingsRouteDeps{Store: store}

	req := httptest.NewRequest(http.MethodPut, "/v1/retry-settings", strings.NewReader(`{"dunningLadderHours":[24],"maxAttemptsPerPayment":1,"minSpacingSeconds":0}`))
	rec := httptest.NewRecorder()
	handleUpsertRetrySettings(deps)(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body = %s", rec.Code, rec.Body.String())
	}
}
