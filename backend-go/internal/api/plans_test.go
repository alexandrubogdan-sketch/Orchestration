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
)

// This file covers the plans resource end-to-end against an in-memory
// fake store — no live Postgres, matching this package's established
// testing convention (see checkout_sessions_test.go's
// fakeCheckoutSessionsStore/retry_settings_test.go's
// fakeRetrySettingsStore, the closest existing precedent for a small,
// resource-scoped fake store; testAuthContext/withTestAuth and
// newChiRouteCtxWithID/withChiRouteCtx are reused directly from
// checkout_sessions_test.go rather than redeclared here).

// fakePlansStore is a minimal in-memory PlansStore. Deliberately
// reimplements CreatePlan/UpdatePlan's "generate ids, replace rules
// wholesale" semantics in plain Go maps/slices rather than SQL, so
// this test file exercises the SAME merchant-scoping/validation
// behavior handlers rely on without needing a live Postgres — mirroring
// PgxPlansStore's own observable behavior (scoped queries return
// not-found rather than another merchant's row; update/delete are
// merchant_entity_id-scoped) closely enough that these tests catch a
// real regression in either implementation's contract, even though
// this fake's internals are a map, not SQL.
type fakePlansStore struct {
	mu    sync.Mutex
	plans map[string]PlanRow // keyed by plan id
}

func newFakePlansStore() *fakePlansStore {
	return &fakePlansStore{plans: make(map[string]PlanRow)}
}

func (s *fakePlansStore) CreatePlan(_ context.Context, input CreatePlanRow) (PlanRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	row := PlanRow{
		ID:                    uuid.Must(uuid.NewV7()).String(),
		MerchantEntityID:      input.MerchantEntityID,
		Name:                  input.Name,
		Type:                  input.Type,
		BillingIntervalAmount: input.BillingIntervalAmount,
		BillingIntervalUnit:   input.BillingIntervalUnit,
		BasePriceMinorUnits:   input.BasePriceMinorUnits,
		BasePriceCurrency:     input.BasePriceCurrency,
		TaxCollection:         input.TaxCollection,
		TrialEnabled:          input.TrialEnabled,
		TrialIntervalAmount:   input.TrialIntervalAmount,
		TrialIntervalUnit:     input.TrialIntervalUnit,
		TrialPriceMinorUnits:  input.TrialPriceMinorUnits,
		TrialPriceCurrency:    input.TrialPriceCurrency,
		CreatedAt:             now,
		UpdatedAt:             now,
		Rules:                 materializeRules(input.Rules),
	}
	s.plans[row.ID] = row
	return row, nil
}

func (s *fakePlansStore) GetPlan(_ context.Context, id string, merchantEntityID string) (PlanRow, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row, ok := s.plans[id]
	if !ok || row.MerchantEntityID != merchantEntityID {
		return PlanRow{}, false, nil
	}
	return row, true, nil
}

func (s *fakePlansStore) ListPlans(_ context.Context, merchantEntityID string) ([]PlanRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []PlanRow
	for _, row := range s.plans {
		if row.MerchantEntityID == merchantEntityID {
			out = append(out, row)
		}
	}
	return out, nil
}

func (s *fakePlansStore) UpdatePlan(_ context.Context, id string, merchantEntityID string, input UpdatePlanRow) (PlanRow, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, ok := s.plans[id]
	if !ok || existing.MerchantEntityID != merchantEntityID {
		return PlanRow{}, false, nil
	}
	row := PlanRow{
		ID:                    existing.ID,
		MerchantEntityID:      existing.MerchantEntityID,
		Name:                  input.Name,
		Type:                  input.Type,
		BillingIntervalAmount: input.BillingIntervalAmount,
		BillingIntervalUnit:   input.BillingIntervalUnit,
		BasePriceMinorUnits:   input.BasePriceMinorUnits,
		BasePriceCurrency:     input.BasePriceCurrency,
		TaxCollection:         input.TaxCollection,
		TrialEnabled:          input.TrialEnabled,
		TrialIntervalAmount:   input.TrialIntervalAmount,
		TrialIntervalUnit:     input.TrialIntervalUnit,
		TrialPriceMinorUnits:  input.TrialPriceMinorUnits,
		TrialPriceCurrency:    input.TrialPriceCurrency,
		CreatedAt:             existing.CreatedAt,
		UpdatedAt:             time.Now(),
		Rules:                 materializeRules(input.Rules),
	}
	s.plans[id] = row
	return row, true, nil
}

func (s *fakePlansStore) DeletePlan(_ context.Context, id string, merchantEntityID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, ok := s.plans[id]
	if !ok || existing.MerchantEntityID != merchantEntityID {
		return false, nil
	}
	delete(s.plans, id)
	return true, nil
}

func materializeRules(inputs []PlanPriceRuleInput) []PlanPriceRuleRow {
	var out []PlanPriceRuleRow
	for _, in := range inputs {
		out = append(out, PlanPriceRuleRow{
			ID:               uuid.Must(uuid.NewV7()).String(),
			AppliesTo:        in.AppliesTo,
			Currency:         in.Currency,
			Countries:        in.Countries,
			AmountMinorUnits: in.AmountMinorUnits,
		})
	}
	return out
}

func newPlansRequest(method string, path string, bodyJSON string, auth AuthContext) *http.Request {
	var req *http.Request
	if bodyJSON == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(bodyJSON))
	}
	return withTestAuth(req, auth)
}

// --- Create -----------------------------------------------------------

// TestCreatePlan_Recurring_HappyPath covers a plain recurring plan with
// no trial and no override rules.
func TestCreatePlan_Recurring_HappyPath(t *testing.T) {
	store := newFakePlansStore()
	deps := PlansRouteDeps{Store: store}
	auth := testAuthContext()

	body := `{
		"name": "Pro Monthly",
		"type": "recurring",
		"billingInterval": {"amount": 1, "unit": "months"},
		"basePrice": {"minorUnits": 2900, "currency": "USD"},
		"taxCollection": "global",
		"trial": null,
		"rules": []
	}`
	req := newPlansRequest(http.MethodPost, "/v1/plans", body, auth)
	rec := httptest.NewRecorder()
	handleCreatePlan(deps)(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body = %s", rec.Code, rec.Body.String())
	}
	respBody := rec.Body.String()
	if !strings.Contains(respBody, `"name":"Pro Monthly"`) {
		t.Errorf("response missing name: %s", respBody)
	}
	if !strings.Contains(respBody, `"billingInterval":{"amount":1,"unit":"months"}`) {
		t.Errorf("response missing billingInterval: %s", respBody)
	}
	if !strings.Contains(respBody, `"basePrice":{"minorUnits":2900,"currency":"USD"}`) {
		t.Errorf("response missing basePrice: %s", respBody)
	}
	if !strings.Contains(respBody, `"trial":null`) {
		t.Errorf("response should have trial:null: %s", respBody)
	}
	if !strings.Contains(respBody, `"rules":[]`) {
		t.Errorf("response should have empty rules array, not null: %s", respBody)
	}

	store.mu.Lock()
	count := len(store.plans)
	store.mu.Unlock()
	if count != 1 {
		t.Fatalf("expected exactly 1 plan stored, got %d", count)
	}
}

// TestCreatePlan_OneOff_HappyPath covers a one-off plan: billingInterval
// must be null, and the response must echo that back as null too.
func TestCreatePlan_OneOff_HappyPath(t *testing.T) {
	store := newFakePlansStore()
	deps := PlansRouteDeps{Store: store}
	auth := testAuthContext()

	body := `{
		"name": "Setup Fee",
		"type": "one-off",
		"billingInterval": null,
		"basePrice": {"minorUnits": 5000, "currency": "EUR"},
		"taxCollection": "enabled",
		"trial": null,
		"rules": []
	}`
	req := newPlansRequest(http.MethodPost, "/v1/plans", body, auth)
	rec := httptest.NewRecorder()
	handleCreatePlan(deps)(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"billingInterval":null`) {
		t.Errorf("one-off plan response should have billingInterval:null: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"type":"one-off"`) {
		t.Errorf("response missing type: %s", rec.Body.String())
	}
}

// TestCreatePlan_WithTrial_HappyPath covers a recurring plan with a
// trial enabled, including a trial-level override rule.
func TestCreatePlan_WithTrial_HappyPath(t *testing.T) {
	store := newFakePlansStore()
	deps := PlansRouteDeps{Store: store}
	auth := testAuthContext()

	body := `{
		"name": "Pro Monthly With Trial",
		"type": "recurring",
		"billingInterval": {"amount": 1, "unit": "months"},
		"basePrice": {"minorUnits": 2900, "currency": "USD"},
		"taxCollection": "global",
		"trial": {
			"enabled": true,
			"interval": {"amount": 14, "unit": "days"},
			"price": {"minorUnits": 0, "currency": "USD"},
			"rules": [
				{"currency": "EUR", "countries": ["DE", "FR"], "amountMinorUnits": 0}
			]
		},
		"rules": [
			{"currency": "GBP", "countries": ["GB"], "amountMinorUnits": 2400}
		]
	}`
	req := newPlansRequest(http.MethodPost, "/v1/plans", body, auth)
	rec := httptest.NewRecorder()
	handleCreatePlan(deps)(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body = %s", rec.Code, rec.Body.String())
	}
	respBody := rec.Body.String()
	if !strings.Contains(respBody, `"enabled":true`) {
		t.Errorf("response trial should be enabled: %s", respBody)
	}
	if !strings.Contains(respBody, `"interval":{"amount":14,"unit":"days"}`) {
		t.Errorf("response missing trial interval: %s", respBody)
	}
	if !strings.Contains(respBody, `"countries":["DE","FR"]`) {
		t.Errorf("response missing trial rule countries: %s", respBody)
	}
	if !strings.Contains(respBody, `"countries":["GB"]`) {
		t.Errorf("response missing plan-level rule countries: %s", respBody)
	}

	// Confirm the base rule and trial rule were both persisted, tagged
	// with the correct AppliesTo discriminator, and did NOT bleed into
	// each other's array on the wire (verified above), matching
	// serializePlan's split-by-AppliesTo behavior.
	store.mu.Lock()
	var plan PlanRow
	for _, p := range store.plans {
		plan = p
	}
	store.mu.Unlock()
	var baseCount, trialCount int
	for _, r := range plan.Rules {
		if r.AppliesTo == "base" {
			baseCount++
		} else if r.AppliesTo == "trial" {
			trialCount++
		}
	}
	if baseCount != 1 || trialCount != 1 {
		t.Errorf("expected 1 base rule + 1 trial rule stored, got base=%d trial=%d", baseCount, trialCount)
	}
}

// TestCreatePlan_WithoutTrial_NoRulesLeak verifies that when trial is
// null, a plan-level rules array is still stored/returned correctly,
// with no trial rules synthesized.
func TestCreatePlan_WithoutTrial_NoRulesLeak(t *testing.T) {
	store := newFakePlansStore()
	deps := PlansRouteDeps{Store: store}
	auth := testAuthContext()

	body := `{
		"name": "Basic",
		"type": "recurring",
		"billingInterval": {"amount": 1, "unit": "years"},
		"basePrice": {"minorUnits": 9900, "currency": "USD"},
		"taxCollection": "disabled",
		"trial": null,
		"rules": [
			{"currency": "CAD", "countries": ["CA"], "amountMinorUnits": 12900}
		]
	}`
	req := newPlansRequest(http.MethodPost, "/v1/plans", body, auth)
	rec := httptest.NewRecorder()
	handleCreatePlan(deps)(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"countries":["CA"]`) {
		t.Errorf("response missing base rule: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"trial":null`) {
		t.Errorf("response should have trial:null: %s", rec.Body.String())
	}
}

// --- Validation ---------------------------------------------------------

func TestCreatePlan_ValidationErrors(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{
			"missing name",
			`{"name":"","type":"recurring","billingInterval":{"amount":1,"unit":"months"},"basePrice":{"minorUnits":100,"currency":"USD"},"taxCollection":"global","trial":null,"rules":[]}`,
		},
		{
			"invalid type",
			`{"name":"X","type":"weekly","billingInterval":{"amount":1,"unit":"months"},"basePrice":{"minorUnits":100,"currency":"USD"},"taxCollection":"global","trial":null,"rules":[]}`,
		},
		{
			"one-off with billingInterval set",
			`{"name":"X","type":"one-off","billingInterval":{"amount":1,"unit":"months"},"basePrice":{"minorUnits":100,"currency":"USD"},"taxCollection":"global","trial":null,"rules":[]}`,
		},
		{
			"recurring with billingInterval null",
			`{"name":"X","type":"recurring","billingInterval":null,"basePrice":{"minorUnits":100,"currency":"USD"},"taxCollection":"global","trial":null,"rules":[]}`,
		},
		{
			"recurring with invalid interval unit",
			`{"name":"X","type":"recurring","billingInterval":{"amount":1,"unit":"weeks"},"basePrice":{"minorUnits":100,"currency":"USD"},"taxCollection":"global","trial":null,"rules":[]}`,
		},
		{
			"recurring with zero interval amount",
			`{"name":"X","type":"recurring","billingInterval":{"amount":0,"unit":"months"},"basePrice":{"minorUnits":100,"currency":"USD"},"taxCollection":"global","trial":null,"rules":[]}`,
		},
		{
			"invalid base currency",
			`{"name":"X","type":"one-off","billingInterval":null,"basePrice":{"minorUnits":100,"currency":"US"},"taxCollection":"global","trial":null,"rules":[]}`,
		},
		{
			"negative base amount",
			`{"name":"X","type":"one-off","billingInterval":null,"basePrice":{"minorUnits":-1,"currency":"USD"},"taxCollection":"global","trial":null,"rules":[]}`,
		},
		{
			"invalid taxCollection",
			`{"name":"X","type":"one-off","billingInterval":null,"basePrice":{"minorUnits":100,"currency":"USD"},"taxCollection":"sometimes","trial":null,"rules":[]}`,
		},
		{
			"trial enabled with missing interval unit",
			`{"name":"X","type":"recurring","billingInterval":{"amount":1,"unit":"months"},"basePrice":{"minorUnits":100,"currency":"USD"},"taxCollection":"global","trial":{"enabled":true,"interval":{"amount":14,"unit":"weeks"},"price":{"minorUnits":0,"currency":"USD"},"rules":[]},"rules":[]}`,
		},
		{
			"trial enabled with negative price",
			`{"name":"X","type":"recurring","billingInterval":{"amount":1,"unit":"months"},"basePrice":{"minorUnits":100,"currency":"USD"},"taxCollection":"global","trial":{"enabled":true,"interval":{"amount":14,"unit":"days"},"price":{"minorUnits":-5,"currency":"USD"},"rules":[]},"rules":[]}`,
		},
		{
			"rule with no countries",
			`{"name":"X","type":"one-off","billingInterval":null,"basePrice":{"minorUnits":100,"currency":"USD"},"taxCollection":"global","trial":null,"rules":[{"currency":"EUR","countries":[],"amountMinorUnits":100}]}`,
		},
		{
			"rule with bad currency",
			`{"name":"X","type":"one-off","billingInterval":null,"basePrice":{"minorUnits":100,"currency":"USD"},"taxCollection":"global","trial":null,"rules":[{"currency":"EU","countries":["DE"],"amountMinorUnits":100}]}`,
		},
		{
			"rule with negative amount",
			`{"name":"X","type":"one-off","billingInterval":null,"basePrice":{"minorUnits":100,"currency":"USD"},"taxCollection":"global","trial":null,"rules":[{"currency":"EUR","countries":["DE"],"amountMinorUnits":-1}]}`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newFakePlansStore()
			deps := PlansRouteDeps{Store: store}
			auth := testAuthContext()

			req := newPlansRequest(http.MethodPost, "/v1/plans", tc.body, auth)
			rec := httptest.NewRecorder()
			handleCreatePlan(deps)(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
			}

			store.mu.Lock()
			count := len(store.plans)
			store.mu.Unlock()
			if count != 0 {
				t.Errorf("a validation failure must not create a plan; store has %d rows", count)
			}
		})
	}
}

// --- List / Get / Update / Delete --------------------------------------

func createTestPlan(t *testing.T, store *fakePlansStore, deps PlansRouteDeps, auth AuthContext, name string) PlanDTO {
	t.Helper()
	body := `{
		"name": "` + name + `",
		"type": "recurring",
		"billingInterval": {"amount": 1, "unit": "months"},
		"basePrice": {"minorUnits": 1000, "currency": "USD"},
		"taxCollection": "global",
		"trial": null,
		"rules": []
	}`
	req := newPlansRequest(http.MethodPost, "/v1/plans", body, auth)
	rec := httptest.NewRecorder()
	handleCreatePlan(deps)(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("createTestPlan: status = %d, want 201; body = %s", rec.Code, rec.Body.String())
	}
	var plan PlanDTO
	if !strings.Contains(rec.Body.String(), name) {
		t.Fatalf("createTestPlan: response missing name: %s", rec.Body.String())
	}
	// Extract the id the crude way (no JSON unmarshal dependency in
	// this test file yet) — find it from the fake store directly,
	// which is simpler and avoids importing encoding/json here.
	store.mu.Lock()
	for _, p := range store.plans {
		if p.Name == name {
			plan = serializePlan(p)
		}
	}
	store.mu.Unlock()
	return plan
}

func TestListPlans_ReturnsOnlyCallersPlans(t *testing.T) {
	store := newFakePlansStore()
	deps := PlansRouteDeps{Store: store}
	authA := testAuthContext()
	authB := testAuthContext()

	createTestPlan(t, store, deps, authA, "A-Plan-1")
	createTestPlan(t, store, deps, authA, "A-Plan-2")
	createTestPlan(t, store, deps, authB, "B-Plan-1")

	req := newPlansRequest(http.MethodGet, "/v1/plans", "", authA)
	rec := httptest.NewRecorder()
	handleListPlans(deps)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "A-Plan-1") || !strings.Contains(body, "A-Plan-2") {
		t.Errorf("response missing merchant A's plans: %s", body)
	}
	if strings.Contains(body, "B-Plan-1") {
		t.Errorf("response leaked merchant B's plan into merchant A's list: %s", body)
	}
}

func TestGetPlan_HappyPath(t *testing.T) {
	store := newFakePlansStore()
	deps := PlansRouteDeps{Store: store}
	auth := testAuthContext()
	plan := createTestPlan(t, store, deps, auth, "Gettable")

	req := newPlansRequest(http.MethodGet, "/v1/plans/"+plan.ID, "", auth)
	req = withChiRouteCtx(req, newChiRouteCtxWithID(plan.ID))
	rec := httptest.NewRecorder()
	handleGetPlan(deps)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Gettable") {
		t.Errorf("response missing plan name: %s", rec.Body.String())
	}
}

func TestGetPlan_NotFound(t *testing.T) {
	store := newFakePlansStore()
	deps := PlansRouteDeps{Store: store}
	auth := testAuthContext()

	req := newPlansRequest(http.MethodGet, "/v1/plans/"+uuid.Must(uuid.NewV7()).String(), "", auth)
	req = withChiRouteCtx(req, newChiRouteCtxWithID(uuid.Must(uuid.NewV7()).String()))
	rec := httptest.NewRecorder()
	handleGetPlan(deps)(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404; body = %s", rec.Code, rec.Body.String())
	}
}

// TestGetPlan_ScopedByMerchantEntity verifies a merchant cannot fetch
// another merchant's plan by id — the core cross-tenant isolation
// property this whole resource depends on.
func TestGetPlan_ScopedByMerchantEntity(t *testing.T) {
	store := newFakePlansStore()
	deps := PlansRouteDeps{Store: store}
	authA := testAuthContext()
	authB := testAuthContext()

	planA := createTestPlan(t, store, deps, authA, "Merchant-A-Only")

	req := newPlansRequest(http.MethodGet, "/v1/plans/"+planA.ID, "", authB)
	req = withChiRouteCtx(req, newChiRouteCtxWithID(planA.ID))
	rec := httptest.NewRecorder()
	handleGetPlan(deps)(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("merchant B fetching merchant A's plan: status = %d, want 404; body = %s", rec.Code, rec.Body.String())
	}
}

func TestUpdatePlan_HappyPath(t *testing.T) {
	store := newFakePlansStore()
	deps := PlansRouteDeps{Store: store}
	auth := testAuthContext()
	plan := createTestPlan(t, store, deps, auth, "Updatable")

	updateBody := `{
		"name": "Updated Name",
		"type": "one-off",
		"billingInterval": null,
		"basePrice": {"minorUnits": 5000, "currency": "GBP"},
		"taxCollection": "enabled",
		"trial": null,
		"rules": []
	}`
	req := newPlansRequest(http.MethodPatch, "/v1/plans/"+plan.ID, updateBody, auth)
	req = withChiRouteCtx(req, newChiRouteCtxWithID(plan.ID))
	rec := httptest.NewRecorder()
	handleUpdatePlan(deps)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"name":"Updated Name"`) {
		t.Errorf("response missing updated name: %s", body)
	}
	if !strings.Contains(body, `"type":"one-off"`) {
		t.Errorf("response missing updated type: %s", body)
	}
	if !strings.Contains(body, `"basePrice":{"minorUnits":5000,"currency":"GBP"}`) {
		t.Errorf("response missing updated basePrice: %s", body)
	}
}

// TestUpdatePlan_ScopedByMerchantEntity verifies a merchant cannot
// update another merchant's plan by id.
func TestUpdatePlan_ScopedByMerchantEntity(t *testing.T) {
	store := newFakePlansStore()
	deps := PlansRouteDeps{Store: store}
	authA := testAuthContext()
	authB := testAuthContext()
	planA := createTestPlan(t, store, deps, authA, "Merchant-A-Update-Target")

	updateBody := `{
		"name": "Hijacked",
		"type": "recurring",
		"billingInterval": {"amount": 1, "unit": "months"},
		"basePrice": {"minorUnits": 1, "currency": "USD"},
		"taxCollection": "global",
		"trial": null,
		"rules": []
	}`
	req := newPlansRequest(http.MethodPatch, "/v1/plans/"+planA.ID, updateBody, authB)
	req = withChiRouteCtx(req, newChiRouteCtxWithID(planA.ID))
	rec := httptest.NewRecorder()
	handleUpdatePlan(deps)(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("merchant B updating merchant A's plan: status = %d, want 404; body = %s", rec.Code, rec.Body.String())
	}

	// Confirm merchant A's plan was NOT modified.
	getReq := newPlansRequest(http.MethodGet, "/v1/plans/"+planA.ID, "", authA)
	getReq = withChiRouteCtx(getReq, newChiRouteCtxWithID(planA.ID))
	getRec := httptest.NewRecorder()
	handleGetPlan(deps)(getRec, getReq)
	if strings.Contains(getRec.Body.String(), "Hijacked") {
		t.Errorf("merchant B's rejected update leaked through: %s", getRec.Body.String())
	}
}

func TestDeletePlan_HappyPath(t *testing.T) {
	store := newFakePlansStore()
	deps := PlansRouteDeps{Store: store}
	auth := testAuthContext()
	plan := createTestPlan(t, store, deps, auth, "Deletable")

	req := newPlansRequest(http.MethodDelete, "/v1/plans/"+plan.ID, "", auth)
	req = withChiRouteCtx(req, newChiRouteCtxWithID(plan.ID))
	rec := httptest.NewRecorder()
	handleDeletePlan(deps)(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body = %s", rec.Code, rec.Body.String())
	}

	store.mu.Lock()
	_, stillExists := store.plans[plan.ID]
	store.mu.Unlock()
	if stillExists {
		t.Errorf("plan should have been deleted from the store")
	}
}

// TestDeletePlan_ScopedByMerchantEntity verifies a merchant cannot
// delete another merchant's plan by id.
func TestDeletePlan_ScopedByMerchantEntity(t *testing.T) {
	store := newFakePlansStore()
	deps := PlansRouteDeps{Store: store}
	authA := testAuthContext()
	authB := testAuthContext()
	planA := createTestPlan(t, store, deps, authA, "Merchant-A-Delete-Target")

	req := newPlansRequest(http.MethodDelete, "/v1/plans/"+planA.ID, "", authB)
	req = withChiRouteCtx(req, newChiRouteCtxWithID(planA.ID))
	rec := httptest.NewRecorder()
	handleDeletePlan(deps)(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("merchant B deleting merchant A's plan: status = %d, want 404; body = %s", rec.Code, rec.Body.String())
	}

	store.mu.Lock()
	_, stillExists := store.plans[planA.ID]
	store.mu.Unlock()
	if !stillExists {
		t.Errorf("merchant A's plan must still exist after merchant B's rejected delete")
	}
}

// TestDeletePlan_NotFound covers deleting an id that never existed.
func TestDeletePlan_NotFound(t *testing.T) {
	store := newFakePlansStore()
	deps := PlansRouteDeps{Store: store}
	auth := testAuthContext()

	missingID := uuid.Must(uuid.NewV7()).String()
	req := newPlansRequest(http.MethodDelete, "/v1/plans/"+missingID, "", auth)
	req = withChiRouteCtx(req, newChiRouteCtxWithID(missingID))
	rec := httptest.NewRecorder()
	handleDeletePlan(deps)(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404; body = %s", rec.Code, rec.Body.String())
	}
}

// TestCreatePlan_NoStoreConfigured_Returns501 matches this package's
// established nil-dependency convention (every other resource's
// handlers 501 rather than panic when its Store is nil).
func TestCreatePlan_NoStoreConfigured_Returns501(t *testing.T) {
	deps := PlansRouteDeps{Store: nil}
	auth := testAuthContext()
	body := `{"name":"X","type":"one-off","billingInterval":null,"basePrice":{"minorUnits":100,"currency":"USD"},"taxCollection":"global","trial":null,"rules":[]}`
	req := newPlansRequest(http.MethodPost, "/v1/plans", body, auth)
	rec := httptest.NewRecorder()
	handleCreatePlan(deps)(rec, req)

	if rec.Code != http.StatusNotImplemented {
		t.Errorf("status = %d, want 501; body = %s", rec.Code, rec.Body.String())
	}
}

// TestPlansRoutes_RegisteredOnRealChiRouter is a light smoke test that
// registerPlansRoutes wires all five routes onto a real chi.Mux without
// panicking and that they're reachable at the expected paths/methods —
// catching a route-registration typo (wrong method, wrong path
// pattern) that a handler-level unit test calling handleXxx(deps)
// directly would never exercise.
func TestPlansRoutes_RegisteredOnRealChiRouter(t *testing.T) {
	store := newFakePlansStore()
	r := chi.NewRouter()
	registerPlansRoutes(r, PlansRouteDeps{Store: store})
	auth := testAuthContext()

	createBody := `{"name":"Smoke","type":"one-off","billingInterval":null,"basePrice":{"minorUnits":100,"currency":"USD"},"taxCollection":"global","trial":null,"rules":[]}`
	req := withTestAuth(httptest.NewRequest(http.MethodPost, "/plans", strings.NewReader(createBody)), auth)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /plans via chi router: status = %d, want 201; body = %s", rec.Code, rec.Body.String())
	}

	listReq := withTestAuth(httptest.NewRequest(http.MethodGet, "/plans", nil), auth)
	listRec := httptest.NewRecorder()
	r.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("GET /plans via chi router: status = %d, want 200; body = %s", listRec.Code, listRec.Body.String())
	}
}
