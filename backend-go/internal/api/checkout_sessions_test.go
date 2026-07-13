package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/alphapayments/payment-orchestrator/internal/adapters/registry"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// newChiRouteCtxWithID and withChiRouteCtx are small test helpers that
// simulate chi's URL-param injection without actually running a
// chi.Mux — these handlers are invoked directly (handleXxx(deps)(rec,
// req)) rather than through a real router in every test below, so
// chi.URLParam(r, "id") needs a *chi.Context manually attached to the
// request's context the same way chi's own routing middleware would.
// This is the standard, chi-documented way to unit test a handler that
// reads chi.URLParam without spinning up a real router.
func newChiRouteCtxWithID(id string) *chi.Context {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	return rctx
}

func withChiRouteCtx(r *http.Request, rctx *chi.Context) *http.Request {
	ctx := context.WithValue(r.Context(), chi.RouteCtxKey, rctx)
	return r.WithContext(ctx)
}

// This file covers the checkout_sessions resource end-to-end against
// in-memory fakes — no live Postgres/Redis, matching this package's
// established testing convention (see idempotency_test.go's
// fakeIdempotencyStore/fakeIdempotencyCache, reused directly below
// rather than redeclared).
//
// fakePaymentsStore/fakeCheckoutSessionsStore are hand-rolled in-memory
// implementations of PaymentsStore/CheckoutSessionsStore — there was no
// pre-existing fake-PaymentsStore in this package to reuse (payments.go
// itself has no _test.go file in this repo), so this file builds the
// minimal one the checkout-sessions handlers actually exercise.

// fakePaymentsStore is a minimal in-memory PaymentsStore — only the
// methods checkout_sessions.go's handlers actually call are meaningfully
// implemented; every other PaymentsStore method returns
// ErrNotImplemented, matching UnimplementedPaymentsStore's own posture
// for methods genuinely out of this test file's scope.
type fakePaymentsStore struct {
	mu sync.Mutex

	customersByEmail  map[string]string // merchantEntityID+"|"+email -> customerID
	customerEmails    map[string]string // customerID -> email
	pspAccounts       map[string]PspAccountRow
	paymentsByID      map[string]PaymentRow
	paymentsByIdemKey map[string]string           // idempotencyKey -> paymentID
	paymentMethods    map[string]PaymentMethodRow // keyed by customerID+"|"+pspAccountID+"|"+ref
	routingDecision   RoutingDecision
}

func newFakePaymentsStore(pspAccount PspAccountRow, routingDecision RoutingDecision) *fakePaymentsStore {
	return &fakePaymentsStore{
		customersByEmail:  make(map[string]string),
		customerEmails:    make(map[string]string),
		pspAccounts:       map[string]PspAccountRow{pspAccount.ID: pspAccount},
		paymentsByID:      make(map[string]PaymentRow),
		paymentsByIdemKey: make(map[string]string),
		paymentMethods:    make(map[string]PaymentMethodRow),
		routingDecision:   routingDecision,
	}
}

func (s *fakePaymentsStore) ResolveCustomerID(_ context.Context, merchantEntityID string, customerID *string, customerEmail *string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if customerID != nil && *customerID != "" {
		return *customerID, nil
	}
	if customerEmail == nil {
		return "", ErrNotImplemented
	}
	key := merchantEntityID + "|" + *customerEmail
	if id, ok := s.customersByEmail[key]; ok {
		return id, nil
	}
	id := uuid.Must(uuid.NewV7()).String()
	s.customersByEmail[key] = id
	s.customerEmails[id] = *customerEmail
	return id, nil
}

func (s *fakePaymentsStore) FindPaymentByIdempotencyKey(_ context.Context, _ string, idempotencyKey string) (PaymentRow, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.paymentsByIdemKey[idempotencyKey]
	if !ok {
		return PaymentRow{}, false, nil
	}
	return s.paymentsByID[id], true, nil
}

func (s *fakePaymentsStore) ResolveRouting(context.Context, string, string, string, string) (RoutingDecision, error) {
	return s.routingDecision, nil
}

func (s *fakePaymentsStore) CreatePayment(_ context.Context, input CreatePaymentRow) (PaymentRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Mirrors PgxPaymentsStore.FindPaymentByIdempotencyKey's role in
	// createPaymentHandler/confirmCheckoutSessionHandler: a second call
	// with the SAME idempotency key returns the SAME row rather than
	// creating a duplicate — this is exactly the property
	// TestConfirmCheckoutSession_AlreadyConsumedIsIdempotent below
	// depends on.
	if existingID, ok := s.paymentsByIdemKey[input.IdempotencyKey]; ok {
		return s.paymentsByID[existingID], nil
	}
	now := time.Now()
	row := PaymentRow{
		ID:              uuid.Must(uuid.NewV7()).String(),
		ProductID:       input.ProductID,
		CustomerID:      input.CustomerID,
		AmountMinor:     input.AmountMinor,
		Currency:        input.Currency,
		State:           "created",
		CitMit:          input.CitMit,
		CreatedAt:       now,
		UpdatedAt:       now,
		RoutingDecision: &input.RoutingDecision,
	}
	s.paymentsByID[row.ID] = row
	s.paymentsByIdemKey[input.IdempotencyKey] = row.ID
	return row, nil
}

func (s *fakePaymentsStore) GetPspAccount(_ context.Context, id string) (PspAccountRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row, ok := s.pspAccounts[id]
	if !ok {
		return PspAccountRow{}, ErrNotImplemented
	}
	return row, nil
}

func (s *fakePaymentsStore) FindAttempt(context.Context, string, int) (AttemptRow, bool, error) {
	return AttemptRow{}, false, nil
}

func (s *fakePaymentsStore) LatestAttempt(context.Context, string) (AttemptRow, bool, error) {
	return AttemptRow{}, false, nil
}

func (s *fakePaymentsStore) UpsertPaymentMethod(_ context.Context, customerID string, pspAccountID string, pspPaymentMethodRef string) (PaymentMethodRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := customerID + "|" + pspAccountID + "|" + pspPaymentMethodRef
	if pm, ok := s.paymentMethods[key]; ok {
		return pm, nil
	}
	pm := PaymentMethodRow{
		ID:                  uuid.Must(uuid.NewV7()).String(),
		Type:                "card",
		IsActive:            true,
		CreatedAt:           time.Now(),
		PspPaymentMethodRef: pspPaymentMethodRef,
	}
	s.paymentMethods[key] = pm
	return pm, nil
}

func (s *fakePaymentsStore) LookupCustomerEmail(_ context.Context, customerID string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	email, ok := s.customerEmails[customerID]
	return email, ok, nil
}

func (s *fakePaymentsStore) RecordAttempt(context.Context, RecordAttemptRow) error { return nil }

func (s *fakePaymentsStore) ApplyCanonicalEvents(context.Context, string, []domain.CanonicalEvent, string) error {
	return nil
}

func (s *fakePaymentsStore) GetPayment(_ context.Context, id string, _ string) (PaymentRow, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row, ok := s.paymentsByID[id]
	return row, ok, nil
}

func (s *fakePaymentsStore) ListAttempts(context.Context, string) ([]AttemptRow, error) { return nil, nil }
func (s *fakePaymentsStore) ListEvents(context.Context, string) ([]PaymentEventRow, error) {
	return nil, nil
}
func (s *fakePaymentsStore) ListPayments(context.Context, string, ListPaymentsQuery) ([]PaymentRow, error) {
	return nil, nil
}

// fakeCheckoutSessionsStore is a minimal in-memory CheckoutSessionsStore.
type fakeCheckoutSessionsStore struct {
	mu       sync.Mutex
	sessions map[string]CheckoutSessionRow
}

func newFakeCheckoutSessionsStore() *fakeCheckoutSessionsStore {
	return &fakeCheckoutSessionsStore{sessions: make(map[string]CheckoutSessionRow)}
}

func (s *fakeCheckoutSessionsStore) CreateCheckoutSession(_ context.Context, input CreateCheckoutSessionRow) (CheckoutSessionRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row := CheckoutSessionRow{
		ID:               uuid.Must(uuid.NewV7()).String(),
		MerchantEntityID: input.MerchantEntityID,
		ProductID:        input.ProductID,
		CustomerID:       input.CustomerID,
		AmountMinor:      input.AmountMinor,
		Currency:         input.Currency,
		CitMit:           input.CitMit,
		PspAccountID:     input.PspAccountID,
		ClientSecretHash: input.ClientSecretHash,
		Status:           "open",
		CreatedAt:        time.Now(),
		ExpiresAt:        input.ExpiresAt,
	}
	s.sessions[row.ID] = row
	return row, nil
}

func (s *fakeCheckoutSessionsStore) GetCheckoutSession(_ context.Context, id string) (CheckoutSessionRow, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row, ok := s.sessions[id]
	return row, ok, nil
}

func (s *fakeCheckoutSessionsStore) MarkCheckoutSessionConsumed(_ context.Context, id string, paymentID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	row, ok := s.sessions[id]
	if !ok {
		return ErrNotImplemented
	}
	row.Status = "consumed"
	pid := paymentID
	row.PaymentID = &pid
	s.sessions[id] = row
	return nil
}

// testCheckoutDeps wires up a full CheckoutSessionsRouteDeps against
// in-memory fakes plus a real registry.Registry (mock adapter only —
// New(Config{}, nil).Resolve short-circuits to the shared mock adapter
// for PSP: "mock" with no credentials needed, exactly as
// registry_test.go's own TestResolve_MockAlwaysSucceeds relies on).
func testCheckoutDeps(t *testing.T) (CheckoutSessionsRouteDeps, *fakeCheckoutSessionsStore, *fakePaymentsStore, PspAccountRow) {
	t.Helper()
	pspAccount := PspAccountRow{ID: uuid.Must(uuid.NewV7()).String(), PSP: "mock", Mode: "sandbox"}
	paymentsStore := newFakePaymentsStore(pspAccount, RoutingDecision{PspAccountID: pspAccount.ID})
	checkoutStore := newFakeCheckoutSessionsStore()
	reg := registry.New(registry.Config{}, nil)

	deps := CheckoutSessionsRouteDeps{
		Store:         checkoutStore,
		PaymentsStore: paymentsStore,
		Registry:      reg,
		Idempotency:   newFakeIdempotencyStore(),
		Cache:         newFakeIdempotencyCache(),
	}
	return deps, checkoutStore, paymentsStore, pspAccount
}

func testAuthContext() AuthContext {
	return AuthContext{
		APITokenID:       "tok_1",
		ProductID:        uuid.Must(uuid.NewV7()).String(),
		MerchantEntityID: uuid.Must(uuid.NewV7()).String(),
	}
}

func withTestAuth(r *http.Request, auth AuthContext) *http.Request {
	ctx := context.WithValue(r.Context(), authContextKey, auth)
	return r.WithContext(ctx)
}

// TestCreateCheckoutSession_HappyPath covers POST /v1/checkout-sessions:
// a Bearer-authenticated request resolves customer+routing and returns
// 201 with a plaintext client secret.
func TestCreateCheckoutSession_HappyPath(t *testing.T) {
	deps, _, _, _ := testCheckoutDeps(t)
	auth := testAuthContext()

	body := `{"customerEmail":"buyer@example.com","amount":{"minorUnits":1500,"currency":"USD"}}`
	req := httptest.NewRequest(http.MethodPost, "/v1/checkout-sessions", strings.NewReader(body))
	req = withTestAuth(req, auth)
	rec := httptest.NewRecorder()

	handleCreateCheckoutSession(deps)(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"clientSecret":"cs_live_`) {
		t.Errorf("response body missing a cs_live_ clientSecret: %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"clientSecretHash"`) {
		t.Errorf("response body must never expose clientSecretHash: %s", rec.Body.String())
	}
}

// createSessionForTest is a test helper: runs the create handler and
// extracts the session id + plaintext client secret from the response,
// so the public/confirm tests below don't have to parse JSON by hand
// repeatedly.
func createSessionForTest(t *testing.T, deps CheckoutSessionsRouteDeps, auth AuthContext) (id string, clientSecret string) {
	t.Helper()
	body := `{"customerEmail":"buyer@example.com","amount":{"minorUnits":1500,"currency":"USD"}}`
	req := httptest.NewRequest(http.MethodPost, "/v1/checkout-sessions", strings.NewReader(body))
	req = withTestAuth(req, auth)
	rec := httptest.NewRecorder()

	handleCreateCheckoutSession(deps)(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("createSessionForTest: status = %d, body = %s", rec.Code, rec.Body.String())
	}

	respBody := rec.Body.String()
	id = extractJSONStringField(t, respBody, "id")
	clientSecret = extractJSONStringField(t, respBody, "clientSecret")
	return id, clientSecret
}

// extractJSONStringField is a tiny hand-rolled helper (not a real JSON
// parse) that finds `"field":"value"` in a JSON object body — sufficient
// for this test file's flat DTOs and avoids pulling in encoding/json
// decode-into-a-struct boilerplate for every assertion.
func extractJSONStringField(t *testing.T, body string, field string) string {
	t.Helper()
	marker := `"` + field + `":"`
	idx := strings.Index(body, marker)
	if idx == -1 {
		t.Fatalf("field %q not found in body: %s", field, body)
	}
	start := idx + len(marker)
	end := strings.Index(body[start:], `"`)
	if end == -1 {
		t.Fatalf("field %q value unterminated in body: %s", field, body)
	}
	return body[start : start+end]
}

func newPublicRequest(id string, clientSecret string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/checkout/"+id+"/public?clientSecret="+clientSecret, nil)
	rctx := newChiRouteCtxWithID(id)
	return withChiRouteCtx(req, rctx)
}

// TestGetPublicCheckoutSession_CorrectSecret verifies the happy path:
// correct id + correct clientSecret returns 200 with a PublicConfig.
func TestGetPublicCheckoutSession_CorrectSecret(t *testing.T) {
	deps, _, _, _ := testCheckoutDeps(t)
	auth := testAuthContext()
	id, secret := createSessionForTest(t, deps, auth)

	req := newPublicRequest(id, secret)
	rec := httptest.NewRecorder()
	handleGetPublicCheckoutSession(deps)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"psp":"mock"`) {
		t.Errorf("response missing psp=mock: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"publishableKey":"pk_mock_test"`) {
		t.Errorf("response missing the mock adapter's publishable key: %s", rec.Body.String())
	}
}

// TestGetPublicCheckoutSession_WrongSecretIs404 and
// TestGetPublicCheckoutSession_NonexistentIdIs404 together verify this
// task's core security requirement: a wrong secret against a REAL
// session id, and ANY secret against a session id that doesn't exist at
// all, produce the exact same 404 — never a 410, never a distinguishable
// message — so a caller can never learn "this session exists" from the
// response alone.
func TestGetPublicCheckoutSession_WrongSecretIs404(t *testing.T) {
	deps, _, _, _ := testCheckoutDeps(t)
	auth := testAuthContext()
	id, _ := createSessionForTest(t, deps, auth)

	req := newPublicRequest(id, "cs_live_definitely_the_wrong_secret")
	rec := httptest.NewRecorder()
	handleGetPublicCheckoutSession(deps)(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body = %s", rec.Code, rec.Body.String())
	}
}

func TestGetPublicCheckoutSession_NonexistentIdIs404(t *testing.T) {
	deps, _, _, _ := testCheckoutDeps(t)

	req := newPublicRequest(uuid.Must(uuid.NewV7()).String(), "cs_live_anything_at_all")
	rec := httptest.NewRecorder()
	handleGetPublicCheckoutSession(deps)(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body = %s", rec.Code, rec.Body.String())
	}
}

// TestGetPublicCheckoutSession_ExpiredIs410 verifies that once the
// CORRECT secret is supplied against an expired session, the response
// is 410 (not 404) — proving the secret check really does happen before
// the expiry check, and that expiry is only revealed to a caller who
// already holds the right secret.
func TestGetPublicCheckoutSession_ExpiredIs410(t *testing.T) {
	deps, store, _, _ := testCheckoutDeps(t)
	auth := testAuthContext()
	id, secret := createSessionForTest(t, deps, auth)

	// Force expiry directly in the fake store, simulating time having
	// passed well beyond checkoutSessionTTL.
	store.mu.Lock()
	row := store.sessions[id]
	row.ExpiresAt = time.Now().Add(-1 * time.Minute)
	store.sessions[id] = row
	store.mu.Unlock()

	req := newPublicRequest(id, secret)
	rec := httptest.NewRecorder()
	handleGetPublicCheckoutSession(deps)(rec, req)

	if rec.Code != http.StatusGone {
		t.Fatalf("status = %d, want 410; body = %s", rec.Code, rec.Body.String())
	}

	// And the wrong secret against this SAME now-expired session must
	// still be 404, not 410 — the ordering guarantee holds regardless of
	// the session's real state.
	reqWrong := newPublicRequest(id, "cs_live_wrong")
	recWrong := httptest.NewRecorder()
	handleGetPublicCheckoutSession(deps)(recWrong, reqWrong)
	if recWrong.Code != http.StatusNotFound {
		t.Fatalf("wrong-secret-against-expired-session status = %d, want 404; body = %s", recWrong.Code, recWrong.Body.String())
	}
}

func newConfirmRequest(id string, bodyJSON string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/checkout/"+id+"/confirm", strings.NewReader(bodyJSON))
	rctx := newChiRouteCtxWithID(id)
	return withChiRouteCtx(req, rctx)
}

// TestConfirmCheckoutSession_HappyPath verifies confirm creates a real
// payment (via the fake PaymentsStore) and marks the session consumed.
func TestConfirmCheckoutSession_HappyPath(t *testing.T) {
	deps, checkoutStore, paymentsStore, pspAccount := testCheckoutDeps(t)
	auth := testAuthContext()
	id, secret := createSessionForTest(t, deps, auth)

	bodyJSON := `{"clientSecret":"` + secret + `","paymentMethodRef":"pm_test_ref"}`
	req := newConfirmRequest(id, bodyJSON)
	rec := httptest.NewRecorder()
	handleConfirmCheckoutSession(deps)(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body = %s", rec.Code, rec.Body.String())
	}

	session, ok, err := checkoutStore.GetCheckoutSession(context.Background(), id)
	if err != nil || !ok {
		t.Fatalf("GetCheckoutSession after confirm: ok=%v err=%v", ok, err)
	}
	if session.Status != "consumed" {
		t.Errorf("session.Status = %q, want consumed", session.Status)
	}
	if session.PaymentID == nil {
		t.Fatal("session.PaymentID is nil after a successful confirm")
	}

	if len(paymentsStore.paymentsByID) != 1 {
		t.Fatalf("expected exactly one payment created, got %d", len(paymentsStore.paymentsByID))
	}
	for _, p := range paymentsStore.paymentsByID {
		if p.RoutingDecision == nil || p.RoutingDecision.PspAccountID != pspAccount.ID {
			t.Errorf("created payment's psp_account_id = %+v, want %s (the session's pinned account, NOT a re-resolved one)", p.RoutingDecision, pspAccount.ID)
		}
	}
}

// TestConfirmCheckoutSession_AlreadyConsumedIsIdempotent verifies that
// confirming the same session twice (e.g. a retried browser request)
// does not double-charge — the second call replays the same payment via
// the idempotency-key mechanism (checkoutSessionIdempotencyKey), not a
// second adapter.CreatePayment call.
func TestConfirmCheckoutSession_AlreadyConsumedIsIdempotent(t *testing.T) {
	deps, _, paymentsStore, _ := testCheckoutDeps(t)
	auth := testAuthContext()
	id, secret := createSessionForTest(t, deps, auth)

	bodyJSON := `{"clientSecret":"` + secret + `","paymentMethodRef":"pm_test_ref"}`

	req1 := newConfirmRequest(id, bodyJSON)
	rec1 := httptest.NewRecorder()
	handleConfirmCheckoutSession(deps)(rec1, req1)
	if rec1.Code != http.StatusCreated {
		t.Fatalf("first confirm status = %d, want 201; body = %s", rec1.Code, rec1.Body.String())
	}
	firstPaymentID := extractJSONStringField(t, rec1.Body.String(), "id")

	req2 := newConfirmRequest(id, bodyJSON)
	rec2 := httptest.NewRecorder()
	handleConfirmCheckoutSession(deps)(rec2, req2)
	if rec2.Code != http.StatusCreated {
		t.Fatalf("second (retried) confirm status = %d, want 201; body = %s", rec2.Code, rec2.Body.String())
	}
	secondPaymentID := extractJSONStringField(t, rec2.Body.String(), "id")

	if firstPaymentID != secondPaymentID {
		t.Errorf("retried confirm created a DIFFERENT payment id (%s vs %s) — this is a double-charge bug", firstPaymentID, secondPaymentID)
	}
	if len(paymentsStore.paymentsByID) != 1 {
		t.Errorf("expected exactly one payment after two confirms of the same session, got %d", len(paymentsStore.paymentsByID))
	}
}

// TestConfirmCheckoutSession_WrongSecretIs404 mirrors the GET .../public
// wrong-secret behavior for POST .../confirm — same 404-not-410
// ordering guarantee applies to both clientSecret-authenticated routes.
func TestConfirmCheckoutSession_WrongSecretIs404(t *testing.T) {
	deps, _, _, _ := testCheckoutDeps(t)
	auth := testAuthContext()
	id, _ := createSessionForTest(t, deps, auth)

	bodyJSON := `{"clientSecret":"cs_live_wrong","paymentMethodRef":"pm_test_ref"}`
	req := newConfirmRequest(id, bodyJSON)
	rec := httptest.NewRecorder()
	handleConfirmCheckoutSession(deps)(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body = %s", rec.Code, rec.Body.String())
	}
}
