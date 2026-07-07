package api

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

// This file adds the plans resource: the REAL backend counterpart to a
// feature that, until now, has only ever existed as an in-memory mock
// in the sibling frontend repo (payment-orchestrator-frontend/lib/
// plan-store.ts's zustand store, backed by lib/mock-data.ts's
// defaultPlans() generator). A task titled "Add API endpoint to create
// Plans" was requested once before and only the frontend mock actually
// got built — this file (plus db/migrations/1735777400000_plans.{up,
// down}.sql and pgpaymentsstore.go's Plans methods below) is the real
// thing that task should have produced.
//
// This file deliberately follows checkout_sessions.go's/
// retry_settings.go's established shapes (narrow store interface, a
// Row-suffixed DTO mirroring the table exactly, WriteProblem for every
// error path, doc comments explaining WHY) rather than inventing new
// conventions.
//
// DTO shape deliberately matches the frontend's lib/types.ts Plan/
// TrialConfig/PriceOverrideRule types field-for-field (see
// PlanDTO/TrialDTO/PriceOverrideRuleDTO below) rather than being
// designed independently, per this task's own instruction — a future
// pass wiring the frontend's plan-store.ts up to this live API should
// be a pure plumbing change, never a redesign of either side. The one
// deliberate shape difference: the frontend's Plan.prices is a
// PriceRow[] whose first row conventionally represents "the default,
// all-countries price" (DEFAULT_PRICE_COUNTRY = "ALL"), with every
// other row being a country-specific override — a slightly awkward
// "the base price is buried inside an array" encoding inherited from
// this catalog's original simpler design. This backend instead
// normalizes that into an explicit `basePrice: {minorUnits, currency}`
// object (matching the task brief's own explicit column contract:
// `base_price_minor_units`/`base_price_currency` are dedicated
// columns, not row zero of a rules array) plus a separate `rules`
// array for override-only rows — the same information, cleanly split,
// so a future frontend wiring pass maps plan-store.ts's prices[0] <->
// basePrice and prices[1:] <-> rules (filtered by applies_to) rather
// than requiring this backend to reproduce the frontend's own
// "magic first row" convention.

// PlanRow mirrors the plans table exactly, narrowed to the columns this
// file's handlers/serializer actually read — matching
// CheckoutSessionRow/RetrySettingsRow's own "mirror the table" pattern.
// Trial/billing-interval fields are pointers because they are
// genuinely nullable at the schema level (one-off plans have no
// billing interval; trial_enabled=false plans have no trial fields) —
// see the migration's own doc comment for why these are API-layer
// invariants, not DB CHECK constraints.
type PlanRow struct {
	ID                     string
	MerchantEntityID       string
	Name                   string
	Type                   string
	BillingIntervalAmount  *int
	BillingIntervalUnit    *string
	BasePriceMinorUnits    int64
	BasePriceCurrency      string
	TaxCollection          string
	TrialEnabled           bool
	TrialIntervalAmount    *int
	TrialIntervalUnit      *string
	TrialPriceMinorUnits   *int64
	TrialPriceCurrency     *string
	CreatedAt              time.Time
	UpdatedAt              time.Time
	// Rules holds every plan_price_rules row for this plan, both
	// applies_to='base' and applies_to='trial' — split into the two
	// frontend-facing arrays by serializePlan below, not by the store.
	// Populated by GetPlan/ListPlans/CreatePlan/UpdatePlan; not a
	// separate column on the plans table itself.
	Rules []PlanPriceRuleRow
}

// PlanPriceRuleRow mirrors a plan_price_rules row exactly.
type PlanPriceRuleRow struct {
	ID                string
	AppliesTo         string // "base" or "trial"
	Currency          string
	Countries         []string
	AmountMinorUnits  int64
}

// PlanPriceRuleInput is the input shape for one price-override rule on
// create/update — no ID (the store generates one; see
// CreatePlanRow/UpdatePlanRow's own doc comments for why this file,
// not the caller, owns id generation for rule rows, matching every
// other resource in this package generating its own row ids via
// uuid.NewV7 rather than trusting a client-supplied one).
type PlanPriceRuleInput struct {
	AppliesTo        string
	Currency         string
	Countries        []string
	AmountMinorUnits int64
}

// CreatePlanRow is the input to PlansStore.CreatePlan — every column
// the INSERT needs (plan row + its price_rules rows), fully validated
// by the handler before the store is ever called, matching
// CreateCheckoutSessionRow's own "handler resolves/validates
// everything, store just persists it" division of labor.
type CreatePlanRow struct {
	MerchantEntityID      string
	Name                  string
	Type                  string
	BillingIntervalAmount *int
	BillingIntervalUnit   *string
	BasePriceMinorUnits   int64
	BasePriceCurrency     string
	TaxCollection         string
	TrialEnabled          bool
	TrialIntervalAmount   *int
	TrialIntervalUnit     *string
	TrialPriceMinorUnits  *int64
	TrialPriceCurrency    *string
	Rules                 []PlanPriceRuleInput
}

// UpdatePlanRow is the input to PlansStore.UpdatePlan — identical shape
// to CreatePlanRow (every column is replaceable on update; there is no
// partial-PATCH-of-a-subset-of-fields semantics here, matching
// UpsertRetrySettingsInput's own "every call replaces the whole
// configurable shape" convention, not a JSON-Merge-Patch-style partial
// update). Rules are fully replaced on every update (delete-then-
// reinsert inside the same transaction — see PgxPlansStore.UpdatePlan's
// doc comment for why that is simpler and just as correct as a
// diff-based reconciliation here).
type UpdatePlanRow struct {
	Name                  string
	Type                  string
	BillingIntervalAmount *int
	BillingIntervalUnit   *string
	BasePriceMinorUnits   int64
	BasePriceCurrency     string
	TaxCollection         string
	TrialEnabled          bool
	TrialIntervalAmount   *int
	TrialIntervalUnit     *string
	TrialPriceMinorUnits  *int64
	TrialPriceCurrency    *string
	Rules                 []PlanPriceRuleInput
}

// PlansStore is the minimal persistence capability the plans routes
// need — a separate, narrow interface (this codebase's standing
// convention: see PaymentsStore/CustomersStore/CheckoutSessionsStore/
// RetrySettingsStore each being their own interface) rather than
// folded into PaymentsStore, since a plan is its own resource with no
// dependency on anything PaymentsStore already models.
//
// Every method is scoped by merchantEntityID — matching how
// customers.go's CustomersStore.FindCustomer scopes by
// merchant_entity_id rather than product_id ("payment methods are
// shared across every product under the same legal entity"; a plans
// catalog is exactly the same shape of merchant-entity-level shared
// resource, see the migration's own doc comment) — NOT by productID
// the way PaymentsStore.GetPayment/ListPayments scope by product_id.
// GetPlan/UpdatePlan/DeletePlan's second return value (bool for
// GetPlan; the error path for Update/Delete) is this interface's
// enforcement point for merchant-scoping: a merchant can never see,
// modify, or delete another merchant's plan, because every query this
// interface's real implementation runs filters by merchant_entity_id
// in the WHERE clause itself, not as an after-the-fact check on a
// row already fetched by id alone.
type PlansStore interface {
	CreatePlan(ctx context.Context, input CreatePlanRow) (PlanRow, error)
	GetPlan(ctx context.Context, id string, merchantEntityID string) (PlanRow, bool, error)
	ListPlans(ctx context.Context, merchantEntityID string) ([]PlanRow, error)
	UpdatePlan(ctx context.Context, id string, merchantEntityID string, input UpdatePlanRow) (PlanRow, bool, error)
	DeletePlan(ctx context.Context, id string, merchantEntityID string) (bool, error)
}

// PlansRouteDeps is everything the five plans handlers need.
type PlansRouteDeps struct {
	Store PlansStore
}

// PriceOverrideRuleDTO mirrors the frontend's PriceOverrideRule type
// exactly (payment-orchestrator-frontend/lib/types.ts): `currency`,
// `countries` (ISO-3166 alpha-2 codes), `amountMinorUnits`. `id` is
// included so the frontend's existing "editable list with stable
// per-row ids" pattern (see plan-store.ts's duplicatePlan mapping
// `randomRowId("rule")` onto every cloned rule) has something to key
// off of once real ids replace client-generated ones.
type PriceOverrideRuleDTO struct {
	ID               string   `json:"id"`
	Currency         string   `json:"currency"`
	Countries        []string `json:"countries"`
	AmountMinorUnits int64    `json:"amountMinorUnits"`
}

// BillingIntervalDTO mirrors the frontend's implied
// {billingIntervalUnit, billingIntervalCount} pair, restructured as a
// nested nullable object per this task's explicit DTO contract
// (`billingInterval: {amount, unit} | null`) — null for a one-off
// plan, always present for a recurring one. This is a deliberate
// normalization versus the frontend's current flat
// billingIntervalUnit/billingIntervalCount fields (which today are
// always present on the frontend's Plan type, mock-data-only,  with no
// backend to disagree with it) — see this file's top doc comment for
// why a future frontend-wiring pass should adapt to this backend's
// null-when-absent shape rather than the reverse: a one-off plan
// genuinely has no billing interval, and a nullable nested object says
// that directly instead of leaving two flat fields present-but-
// meaningless.
type BillingIntervalDTO struct {
	Amount int    `json:"amount"`
	Unit   string `json:"unit"`
}

// MoneyMinorDTO mirrors the frontend's PriceRow's
// {amountMinorUnits, currency} pair, restructured as this task's
// explicit `basePrice: {minorUnits, currency}` contract — deliberately
// reusing this package's own MoneyDTO field names (`minorUnits`, not
// `amountMinorUnits`) for consistency with every other money-shaped
// DTO in this package (CreatePaymentRequest.Amount, MoneyDTO itself in
// payments.go), even though the frontend's own PriceRow spells the
// field `amountMinorUnits`. A future frontend-wiring pass needs a
// one-line rename at the store boundary either way (PriceRow[] <->
// basePrice object is already a shape change, not a pure rename); this
// backend follows its OWN established money-DTO convention rather than
// the frontend's, since MoneyDTO is a type this package already has
// many callers of and introducing a second, differently-spelled money
// shape just for plans would be the larger inconsistency.
type MoneyMinorDTO struct {
	MinorUnits int64  `json:"minorUnits"`
	Currency   string `json:"currency"`
}

// TrialDTO mirrors the frontend's TrialConfig type, restructured as a
// nullable object (`trial: {...} | null`) per this task's explicit DTO
// contract, rather than the frontend's always-present TrialConfig with
// its own internal `enabled: boolean` flag. `interval` mirrors
// BillingIntervalDTO's shape for the trial's own length (the frontend's
// TrialConfig.intervalUnit/intervalCount, flattened the same way
// Plan.billingIntervalUnit/billingIntervalCount are above). `price`
// mirrors the plan-level `basePrice` shape for the trial's own price
// (the frontend's TrialConfig.prices[0], normalized the same way
// Plan.prices[0] is above). `rules` mirrors TrialConfig.rules exactly
// (already a PriceOverrideRule[] on both sides — no shape change
// needed here).
type TrialDTO struct {
	Enabled  bool                    `json:"enabled"`
	Interval BillingIntervalDTO      `json:"interval"`
	Price    MoneyMinorDTO           `json:"price"`
	Rules    []PriceOverrideRuleDTO  `json:"rules"`
}

// PlanDTO mirrors the frontend's Plan type field-for-field, modulo the
// basePrice/billingInterval/trial normalizations documented on their
// own DTO types above. `billingInterval`/`trial` are pointers so the
// wire representation is a genuine JSON `null` (via omitempty's
// counterpart — see serializePlan below, which always sets these
// fields explicitly rather than relying on the zero value) for a
// one-off plan / a plan with trials disabled, matching this task's
// explicit `{...} | null` contract literally rather than
// approximating it with a zero-valued struct.
type PlanDTO struct {
	ID              string                  `json:"id"`
	Name            string                  `json:"name"`
	Type            string                  `json:"type"`
	BillingInterval *BillingIntervalDTO     `json:"billingInterval"`
	BasePrice       MoneyMinorDTO           `json:"basePrice"`
	TaxCollection   string                  `json:"taxCollection"`
	Trial           *TrialDTO               `json:"trial"`
	Rules           []PriceOverrideRuleDTO  `json:"rules"`
	CreatedAt       string                  `json:"createdAt"`
	UpdatedAt       string                  `json:"updatedAt"`
}

// ListPlansResponse mirrors GET /v1/plans's response shape: {"data": [...]}
// — the same envelope PaymentMethodsResponse (customers.go) uses,
// matching this package's one shared "list responses are always
// {data: [...]}, never a bare array" convention.
type ListPlansResponse struct {
	Data []PlanDTO `json:"data"`
}

// CreatePlanRequest/UpdatePlanRequest mirror POST /v1/plans and
// PATCH /v1/plans/:id's request bodies — the same shape as PlanDTO
// minus id/createdAt/updatedAt (server-assigned), matching
// UpsertRetrySettingsRequest's own "request body omits the
// server-owned columns" convention. One shared struct for both create
// and update (rather than two nearly-identical ones) because every
// field is required/optional identically on both operations — a PATCH
// here replaces the whole configurable shape (see UpdatePlanRow's own
// doc comment on why this is not a partial-merge PATCH), so create and
// update genuinely take the same request shape.
type PlanRequest struct {
	Name            string                 `json:"name"`
	Type            string                 `json:"type"`
	BillingInterval *BillingIntervalDTO    `json:"billingInterval"`
	BasePrice       MoneyMinorDTO          `json:"basePrice"`
	TaxCollection   string                 `json:"taxCollection"`
	Trial           *TrialDTO              `json:"trial"`
	Rules           []PriceOverrideRuleDTO `json:"rules"`
}

// registerPlansRoutes registers every /v1/plans* route. Called from
// inside router.go's r.Route("/v1", ...) block, alongside
// registerPaymentsRoutes/registerCustomersRoutes/
// registerCheckoutSessionsRoutes/registerRetrySettingsRoutes, so every
// route below goes through authMW.Middleware exactly like every other
// /v1/* route — a merchant's plans catalog is exactly as sensitive a
// piece of configuration as its retry policy, so there's no reason for
// any of these five routes to be unauthenticated.
//
// NO Idempotency-Key requirement on POST/PATCH, unlike
// POST /v1/payments and POST /v1/checkout-sessions — deliberately, and
// unlike those two money-movement routes there is a direct precedent
// for this in the existing codebase: PUT /v1/retry-settings
// (retry_settings.go) is ALSO a Bearer-authenticated mutating route
// with no Idempotency-Key requirement, because it configures merchant
// state rather than moving money. Idempotency-Key protection in this
// codebase exists specifically to make a retried request safe to
// re-send without risking a DOUBLE CHARGE or a duplicate payment
// attempt (see idempotency.go's own doc comment and
// MIGRATION_NOTES.md's Checkout Sessions section on exactly why
// POST /v1/checkout-sessions itself was flagged as a gap for lacking
// this). A plan create/update has no such risk: a retried
// POST /v1/plans in the worst case creates two catalog entries with
// the same name (a merchant-visible, easily-correctable annoyance, not
// a financial-harm bug), and a retried PATCH just re-applies the same
// replacement value a second time (fully safe — PATCH here is a full
// replace, not an increment/append). Requiring a header purely for
// safety this resource doesn't need would be process for its own sake,
// not a real correctness improvement — matching retry-settings' own
// precedent rather than payments'/checkout-sessions'.
func registerPlansRoutes(r chi.Router, deps PlansRouteDeps) {
	r.Post("/plans", handleCreatePlan(deps))
	r.Get("/plans", handleListPlans(deps))
	r.Get("/plans/{id}", handleGetPlan(deps))
	r.Patch("/plans/{id}", handleUpdatePlan(deps))
	r.Delete("/plans/{id}", handleDeletePlan(deps))
}

// serializePlan converts a PlanRow (plus its attached Rules) into the
// frontend-facing PlanDTO, splitting Rules by AppliesTo into the
// plan-level `rules` array (applies_to='base') and the nested trial's
// `rules` array (applies_to='trial') — the read-side counterpart of
// how the write-side handlers below split PlanRequest.Rules/
// PlanRequest.Trial.Rules back into a single flat
// []PlanPriceRuleInput before calling the store (see
// planRequestToRuleInputs).
func serializePlan(row PlanRow) PlanDTO {
	var baseRules, trialRules []PriceOverrideRuleDTO
	for _, rule := range row.Rules {
		dto := PriceOverrideRuleDTO{
			ID:               rule.ID,
			Currency:         rule.Currency,
			Countries:        rule.Countries,
			AmountMinorUnits: rule.AmountMinorUnits,
		}
		if rule.AppliesTo == "trial" {
			trialRules = append(trialRules, dto)
		} else {
			baseRules = append(baseRules, dto)
		}
	}
	// Never nil in the JSON response — an empty slice serializes as
	// `[]`, not `null`, matching this task's DTO contract
	// (`rules: PriceOverrideRule[]`, never nullable) even for a plan
	// with zero override rules.
	if baseRules == nil {
		baseRules = []PriceOverrideRuleDTO{}
	}

	var billingInterval *BillingIntervalDTO
	if row.Type == "recurring" && row.BillingIntervalAmount != nil && row.BillingIntervalUnit != nil {
		billingInterval = &BillingIntervalDTO{Amount: *row.BillingIntervalAmount, Unit: *row.BillingIntervalUnit}
	}

	var trial *TrialDTO
	if row.TrialEnabled {
		if trialRules == nil {
			trialRules = []PriceOverrideRuleDTO{}
		}
		var intervalAmount int
		var intervalUnit string
		var priceMinor int64
		var priceCurrency string
		if row.TrialIntervalAmount != nil {
			intervalAmount = *row.TrialIntervalAmount
		}
		if row.TrialIntervalUnit != nil {
			intervalUnit = *row.TrialIntervalUnit
		}
		if row.TrialPriceMinorUnits != nil {
			priceMinor = *row.TrialPriceMinorUnits
		}
		if row.TrialPriceCurrency != nil {
			priceCurrency = *row.TrialPriceCurrency
		}
		trial = &TrialDTO{
			Enabled:  true,
			Interval: BillingIntervalDTO{Amount: intervalAmount, Unit: intervalUnit},
			Price:    MoneyMinorDTO{MinorUnits: priceMinor, Currency: priceCurrency},
			Rules:    trialRules,
		}
	}

	return PlanDTO{
		ID:              row.ID,
		Name:            row.Name,
		Type:            row.Type,
		BillingInterval: billingInterval,
		BasePrice:       MoneyMinorDTO{MinorUnits: row.BasePriceMinorUnits, Currency: row.BasePriceCurrency},
		TaxCollection:   row.TaxCollection,
		Trial:           trial,
		Rules:           baseRules,
		CreatedAt:       row.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:       row.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

// planRequestToRuleInputs flattens PlanRequest.Rules (applies_to=base)
// and, if trial is enabled, PlanRequest.Trial.Rules (applies_to=trial)
// into the single []PlanPriceRuleInput slice CreatePlanRow/
// UpdatePlanRow carry — the write-side counterpart of serializePlan's
// read-side split above.
func planRequestToRuleInputs(body PlanRequest) []PlanPriceRuleInput {
	var out []PlanPriceRuleInput
	for _, rule := range body.Rules {
		out = append(out, PlanPriceRuleInput{
			AppliesTo:        "base",
			Currency:         rule.Currency,
			Countries:        rule.Countries,
			AmountMinorUnits: rule.AmountMinorUnits,
		})
	}
	if body.Trial != nil && body.Trial.Enabled {
		for _, rule := range body.Trial.Rules {
			out = append(out, PlanPriceRuleInput{
				AppliesTo:        "trial",
				Currency:         rule.Currency,
				Countries:        rule.Countries,
				AmountMinorUnits: rule.AmountMinorUnits,
			})
		}
	}
	return out
}

// validatePlanRequest enforces this resource's validation contract, as
// specified in the task brief:
//   - type must be "recurring" or "one-off".
//   - one-off plans must have billingInterval: null; recurring plans
//     must have it set (both amount >= 1 and a valid unit).
//   - basePrice.currency must be a 3-letter code; minorUnits >= 0
//     (matching handleCreateCheckoutSession's own >= 0 money
//     validation precedent in checkout_sessions.go, rather than
//     leaving a negative amount to surface as an opaque 500 from a
//     CHECK constraint the way payments.go's own pre-existing gap
//     does — this is new code, so there is no "avoid touching a
//     working handler" reason to leave the gap here the way
//     checkout_sessions.go's own comment explains for payments.go).
//   - taxCollection must be one of the three enum values.
//   - trial fields required together or not at all: if trial is
//     non-nil and trial.enabled is true, interval (amount >= 1, valid
//     unit) and price (currency set) must be fully populated; if trial
//     is nil, or trial.enabled is false, none of that is checked (an
//     absent/disabled trial's interval/price/rules are simply not
//     looked at — matching serializePlan's own "trial is nil unless
//     TrialEnabled" convention on the read side).
//   - every rule (plan-level and, if applicable, trial-level) must
//     have a 3-letter currency, at least one country, and a
//     non-negative amountMinorUnits.
func validatePlanRequest(body PlanRequest) error {
	if body.Name == "" {
		return fmt.Errorf("name: required")
	}
	if body.Type != "recurring" && body.Type != "one-off" {
		return fmt.Errorf("type: must be 'recurring' or 'one-off', got %q", body.Type)
	}

	if body.Type == "one-off" {
		if body.BillingInterval != nil {
			return fmt.Errorf("billingInterval: must be null for a one-off plan")
		}
	} else {
		if body.BillingInterval == nil {
			return fmt.Errorf("billingInterval: required for a recurring plan")
		}
		if err := validateBillingInterval(*body.BillingInterval, "billingInterval"); err != nil {
			return err
		}
	}

	if err := validateCurrency(body.BasePrice.Currency, "basePrice.currency"); err != nil {
		return err
	}
	if body.BasePrice.MinorUnits < 0 {
		return fmt.Errorf("basePrice.minorUnits: must be >= 0, got %d", body.BasePrice.MinorUnits)
	}

	switch body.TaxCollection {
	case "global", "enabled", "disabled":
	default:
		return fmt.Errorf("taxCollection: must be 'global', 'enabled', or 'disabled', got %q", body.TaxCollection)
	}

	if body.Trial != nil && body.Trial.Enabled {
		if err := validateBillingInterval(body.Trial.Interval, "trial.interval"); err != nil {
			return err
		}
		if err := validateCurrency(body.Trial.Price.Currency, "trial.price.currency"); err != nil {
			return err
		}
		if body.Trial.Price.MinorUnits < 0 {
			return fmt.Errorf("trial.price.minorUnits: must be >= 0, got %d", body.Trial.Price.MinorUnits)
		}
		for i, rule := range body.Trial.Rules {
			if err := validatePriceOverrideRule(rule, fmt.Sprintf("trial.rules[%d]", i)); err != nil {
				return err
			}
		}
	}

	for i, rule := range body.Rules {
		if err := validatePriceOverrideRule(rule, fmt.Sprintf("rules[%d]", i)); err != nil {
			return err
		}
	}

	return nil
}

func validateBillingInterval(interval BillingIntervalDTO, field string) error {
	if interval.Amount < 1 {
		return fmt.Errorf("%s.amount: must be >= 1, got %d", field, interval.Amount)
	}
	switch interval.Unit {
	case "days", "months", "years":
	default:
		return fmt.Errorf("%s.unit: must be 'days', 'months', or 'years', got %q", field, interval.Unit)
	}
	return nil
}

func validateCurrency(currency string, field string) error {
	if len(currency) != 3 {
		return fmt.Errorf("%s: must be a 3-letter currency code, got %q", field, currency)
	}
	return nil
}

func validatePriceOverrideRule(rule PriceOverrideRuleDTO, field string) error {
	if err := validateCurrency(rule.Currency, field+".currency"); err != nil {
		return err
	}
	if len(rule.Countries) == 0 {
		return fmt.Errorf("%s.countries: must have at least one entry", field)
	}
	if rule.AmountMinorUnits < 0 {
		return fmt.Errorf("%s.amountMinorUnits: must be >= 0, got %d", field, rule.AmountMinorUnits)
	}
	return nil
}

// planRequestToCreateRow converts a validated PlanRequest into a
// CreatePlanRow — merchantEntityID comes from the Bearer auth context,
// exactly like every other /v1/* route scopes writes by
// auth.MerchantEntityID rather than trusting anything client-supplied,
// matching UpsertRetrySettingsRequest's own "no merchantEntityId in the
// request body" convention.
func planRequestToCreateRow(merchantEntityID string, body PlanRequest) CreatePlanRow {
	row := CreatePlanRow{
		MerchantEntityID:    merchantEntityID,
		Name:                body.Name,
		Type:                body.Type,
		BasePriceMinorUnits: body.BasePrice.MinorUnits,
		BasePriceCurrency:   body.BasePrice.Currency,
		TaxCollection:       body.TaxCollection,
		Rules:               planRequestToRuleInputs(body),
	}
	if body.BillingInterval != nil {
		amount := body.BillingInterval.Amount
		unit := body.BillingInterval.Unit
		row.BillingIntervalAmount = &amount
		row.BillingIntervalUnit = &unit
	}
	if body.Trial != nil && body.Trial.Enabled {
		row.TrialEnabled = true
		amount := body.Trial.Interval.Amount
		unit := body.Trial.Interval.Unit
		price := body.Trial.Price.MinorUnits
		currency := body.Trial.Price.Currency
		row.TrialIntervalAmount = &amount
		row.TrialIntervalUnit = &unit
		row.TrialPriceMinorUnits = &price
		row.TrialPriceCurrency = &currency
	}
	return row
}

// planRequestToUpdateRow mirrors planRequestToCreateRow exactly, minus
// MerchantEntityID (UpdatePlanRow carries no merchant/ownership field —
// PlansStore.UpdatePlan takes merchantEntityID as its own separate
// parameter, scoping the UPDATE's WHERE clause, not a column being
// written).
func planRequestToUpdateRow(body PlanRequest) UpdatePlanRow {
	row := UpdatePlanRow{
		Name:                body.Name,
		Type:                body.Type,
		BasePriceMinorUnits: body.BasePrice.MinorUnits,
		BasePriceCurrency:   body.BasePrice.Currency,
		TaxCollection:       body.TaxCollection,
		Rules:               planRequestToRuleInputs(body),
	}
	if body.BillingInterval != nil {
		amount := body.BillingInterval.Amount
		unit := body.BillingInterval.Unit
		row.BillingIntervalAmount = &amount
		row.BillingIntervalUnit = &unit
	}
	if body.Trial != nil && body.Trial.Enabled {
		row.TrialEnabled = true
		amount := body.Trial.Interval.Amount
		unit := body.Trial.Interval.Unit
		price := body.Trial.Price.MinorUnits
		currency := body.Trial.Price.Currency
		row.TrialIntervalAmount = &amount
		row.TrialIntervalUnit = &unit
		row.TrialPriceMinorUnits = &price
		row.TrialPriceCurrency = &currency
	}
	return row
}

// handleCreatePlan implements POST /v1/plans — Bearer-authenticated,
// no Idempotency-Key (see registerPlansRoutes' doc comment for why).
// Validates, converts, persists, responds 201 with the full PlanDTO.
func handleCreatePlan(deps PlansRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := authFromContext(r.Context())
		if !ok {
			WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
			return
		}

		var body PlanRequest
		if !decodeJSONBody(w, r, &body) {
			return
		}
		if err := validatePlanRequest(body); err != nil {
			WriteProblem(w, http.StatusBadRequest, "Validation failed", err.Error())
			return
		}

		if deps.Store == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		plan, err := deps.Store.CreatePlan(r.Context(), planRequestToCreateRow(auth.MerchantEntityID, body))
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		writeJSON(w, http.StatusCreated, serializePlan(plan))
	}
}

// handleListPlans implements GET /v1/plans — Bearer-authenticated,
// scoped to auth.MerchantEntityID. No pagination — matching this
// task's own explicit route list (`GET /v1/plans`, no query
// parameters called out), and a merchant's plans catalog is expected
// to be small (tens, not millions, of rows) unlike payments, which is
// the one resource in this package that DOES need keyset pagination
// (see ListPaymentsQuery/handleListPayments in payments.go).
func handleListPlans(deps PlansRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := authFromContext(r.Context())
		if !ok {
			WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
			return
		}

		if deps.Store == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		rows, err := deps.Store.ListPlans(r.Context(), auth.MerchantEntityID)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		dtos := make([]PlanDTO, 0, len(rows))
		for _, row := range rows {
			dtos = append(dtos, serializePlan(row))
		}
		writeJSON(w, http.StatusOK, ListPlansResponse{Data: dtos})
	}
}

// handleGetPlan implements GET /v1/plans/:id — Bearer-authenticated,
// scoped to auth.MerchantEntityID (a merchant can never fetch another
// merchant's plan by guessing its id — see PlansStore's own doc
// comment on why this is enforced inside the store's query, not as an
// after-the-fetch check here).
func handleGetPlan(deps PlansRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := authFromContext(r.Context())
		if !ok {
			WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
			return
		}
		id := chi.URLParam(r, "id")

		if deps.Store == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		plan, found, err := deps.Store.GetPlan(r.Context(), id, auth.MerchantEntityID)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}
		if !found {
			WriteProblem(w, http.StatusNotFound, "Plan not found", "")
			return
		}

		writeJSON(w, http.StatusOK, serializePlan(plan))
	}
}

// handleUpdatePlan implements PATCH /v1/plans/:id — Bearer-
// authenticated, no Idempotency-Key (see registerPlansRoutes' doc
// comment). A full replace of the plan's configurable shape (see
// UpdatePlanRow's own doc comment), not a partial merge — the request
// body is the SAME PlanRequest shape POST /v1/plans takes, and every
// field it carries overwrites the corresponding column/rule set.
func handleUpdatePlan(deps PlansRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := authFromContext(r.Context())
		if !ok {
			WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
			return
		}
		id := chi.URLParam(r, "id")

		var body PlanRequest
		if !decodeJSONBody(w, r, &body) {
			return
		}
		if err := validatePlanRequest(body); err != nil {
			WriteProblem(w, http.StatusBadRequest, "Validation failed", err.Error())
			return
		}

		if deps.Store == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		plan, found, err := deps.Store.UpdatePlan(r.Context(), id, auth.MerchantEntityID, planRequestToUpdateRow(body))
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}
		if !found {
			WriteProblem(w, http.StatusNotFound, "Plan not found", "")
			return
		}

		writeJSON(w, http.StatusOK, serializePlan(plan))
	}
}

// handleDeletePlan implements DELETE /v1/plans/:id — Bearer-
// authenticated, scoped to auth.MerchantEntityID. Responds 204 with no
// body on success, matching the conventional REST shape for a DELETE
// with nothing to return (no existing DELETE route in this package to
// follow as precedent — payments/checkout-sessions/retry-settings have
// no DELETE route at all — so this follows the plain HTTP convention
// rather than an in-repo one).
func handleDeletePlan(deps PlansRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := authFromContext(r.Context())
		if !ok {
			WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
			return
		}
		id := chi.URLParam(r, "id")

		if deps.Store == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		found, err := deps.Store.DeletePlan(r.Context(), id, auth.MerchantEntityID)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}
		if !found {
			WriteProblem(w, http.StatusNotFound, "Plan not found", "")
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
