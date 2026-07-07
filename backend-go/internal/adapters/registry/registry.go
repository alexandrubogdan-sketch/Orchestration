// Package registry provides the PspAdapterRegistry — resolves a
// psp_accounts row to a ready-to-use adapters.PspAdapter, and
// LoadDeclineMaps — the decline_code_map bulk loader every adapter's
// NormalizeDecline is seeded from. This is the ONLY package outside
// internal/adapters/mock, internal/adapters/stripe, and
// internal/adapters/solidgate that is allowed to know all three
// adapter implementations exist — every caller (the webhook route, the
// normalizer worker, the gap-detection cron — all later phases) goes
// through Resolve and only ever sees the adapters.PspAdapter interface.
//
// NOT YET PORTED (see MIGRATION_NOTES.md's Phase 2 section): the TS
// registry.ts also wires an OutboundRateLimiter (T7.1,
// RateLimitedPspAdapter) and reads psp_accounts/decline_code_map
// directly from a Kysely `Db` handle. Neither the rate limiter nor a
// database access layer exists yet in this Go port (both are later
// phases — routing/rate-limiter and the HTTP/DB layer respectively), so
// this package's Resolve always returns the raw adapter, never a
// rate-limited wrapper, and LoadDeclineMaps takes already-fetched rows
// rather than a *sql.DB/pgx.Pool — a later phase's DB layer is
// responsible for running the `SELECT * FROM decline_code_map` query
// and passing the resulting rows here.
package registry

import (
	"fmt"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/adapters/mock"
	"github.com/alphapayments/payment-orchestrator/internal/adapters/paypal"
	"github.com/alphapayments/payment-orchestrator/internal/adapters/solidgate"
	"github.com/alphapayments/payment-orchestrator/internal/adapters/stripe"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// DeclineCodeMapRow mirrors one row of the decline_code_map table —
// decoupled from any specific DB driver/library, since none is wired
// into this Go port yet. A later phase's DB layer scans rows into this
// shape and passes them to LoadDeclineMaps.
type DeclineCodeMapRow struct {
	PSP            string
	RawCode        string
	NormalizedCode string
	Category       domain.DeclineCategory
	RetryClass     domain.DeclineRetryClass
	Description    *string
}

// LoadDeclineMaps groups decline_code_map rows by psp, so each adapter
// gets an in-memory lookup instead of hitting Postgres per decline
// (T1.4/ADR-0002's caching pattern). Call once at boot; there is
// currently no cache-invalidation path, so a decline_code_map change
// requires a process restart to take effect — acceptable for a table
// that changes on the order of "a PSP adds a new decline code," not
// per-request.
func LoadDeclineMaps(rows []DeclineCodeMapRow) map[string]map[string]domain.NormalizedDecline {
	byPSP := make(map[string]map[string]domain.NormalizedDecline)
	for _, row := range rows {
		forPSP, ok := byPSP[row.PSP]
		if !ok {
			forPSP = make(map[string]domain.NormalizedDecline)
			byPSP[row.PSP] = forPSP
		}
		forPSP[row.RawCode] = domain.NormalizedDecline{
			PSP:            row.PSP,
			RawCode:        row.RawCode,
			NormalizedCode: row.NormalizedCode,
			Category:       row.Category,
			RetryClass:     row.RetryClass,
			Description:    row.Description,
		}
	}
	return byPSP
}

// PspAccount is the subset of a psp_accounts row Resolve needs.
type PspAccount struct {
	ID        string
	PSP       string
	Mode      string
	SecretRef string
}

// Config is the subset of process-wide config the registry needs to
// resolve credentials for each adapter type — decoupled from
// internal/config.Config so this package never has to import it
// directly (keeping the adapter/config boundary explicit, and avoiding
// any import-cycle risk).
type Config struct {
	Stripe    stripe.ConfigCredentials
	Solidgate solidgate.ConfigCredentials
	// PayPal: not yet wired into internal/config.Config (a future
	// PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET/PAYPAL_WEBHOOK_ID/
	// PAYPAL_MODE/PAYPAL_API_BASE_URL env-var wiring, mirroring
	// Solidgate's optional-at-boot pattern, is deliberately out of
	// scope here — see MIGRATION_NOTES.md's PayPal section). Zero-value
	// paypal.ConfigCredentials{} is a legitimate Config for any process
	// with no PayPal psp_accounts configured, exactly like Solidgate's
	// own all-optional ConfigCredentials.
	PayPal paypal.ConfigCredentials
}

// UnknownPspError is returned by Resolve when pspAccount.PSP doesn't
// match any registered adapter implementation.
type UnknownPspError struct {
	PSP string
}

func (e *UnknownPspError) Error() string {
	return fmt.Sprintf("no adapter implementation registered for psp %q", e.PSP)
}

// Registry resolves psp_accounts rows to ready-to-use adapters.PspAdapter
// instances, caching one adapter instance per account id (a Stripe/
// Solidgate client is reasonably expensive to construct and safe to
// reuse across requests).
type Registry struct {
	config      Config
	declineMaps map[string]map[string]domain.NormalizedDecline
	mockAdapter *mock.Adapter
	cache       map[string]adapters.PspAdapter
}

// New constructs a Registry. declineMaps is typically the result of
// LoadDeclineMaps.
func New(config Config, declineMaps map[string]map[string]domain.NormalizedDecline) *Registry {
	if declineMaps == nil {
		declineMaps = map[string]map[string]domain.NormalizedDecline{}
	}
	return &Registry{
		config:      config,
		declineMaps: declineMaps,
		mockAdapter: mock.New(mock.Options{}),
		cache:       make(map[string]adapters.PspAdapter),
	}
}

// Resolve returns a ready-to-use adapters.PspAdapter for pspAccount.
//
// NOT YET PORTED: the TS Resolve wraps the raw adapter in a
// RateLimitedPspAdapter whenever an OutboundRateLimiter was supplied to
// the registry's constructor (T7.1). This Go port's Registry has no
// rate-limiter parameter yet — see this package's doc comment — so
// Resolve always returns the raw, unwrapped adapter. Add a rate
// limiter parameter here once T7.1's Go equivalent exists, mirroring
// the TS constructor's optional third parameter.
func (r *Registry) Resolve(pspAccount PspAccount) (adapters.PspAdapter, error) {
	if pspAccount.PSP == "mock" {
		return r.mockAdapter, nil
	}

	if cached, ok := r.cache[pspAccount.ID]; ok {
		return cached, nil
	}

	switch pspAccount.PSP {
	case "stripe":
		credentials, err := stripe.ResolveCredentials(r.config.Stripe, stripe.PspAccount{
			Mode:      pspAccount.Mode,
			SecretRef: pspAccount.SecretRef,
		})
		if err != nil {
			return nil, err
		}
		adapter := stripe.New(stripe.Options{
			Credentials: credentials,
			APIVersion:  r.config.Stripe.APIVersion,
			DeclineMap:  r.declineMaps["stripe"],
		})
		r.cache[pspAccount.ID] = adapter
		return adapter, nil

	case "solidgate":
		credentials, err := solidgate.ResolveCredentials(r.config.Solidgate, solidgate.PspAccount{
			Mode:      pspAccount.Mode,
			SecretRef: pspAccount.SecretRef,
		})
		if err != nil {
			return nil, err
		}
		// Webhook verification credentials are resolved lazily (only
		// needed if VerifyWebhook is actually called) rather than at
		// construction time — a process with SOLIDGATE_PUBLIC_KEY/
		// SOLIDGATE_SECRET_KEY set but no webhook keys configured can
		// still make outbound Solidgate calls; it just can't verify
		// inbound Solidgate webhooks yet.
		var webhookCredentials *solidgate.WebhookCredentials
		if r.config.Solidgate.WebhookPublicKey != "" && r.config.Solidgate.WebhookSecretKey != "" {
			resolved, err := solidgate.ResolveWebhookCredentials(r.config.Solidgate)
			if err == nil {
				webhookCredentials = &resolved
			}
		}
		adapter := solidgate.New(solidgate.Options{
			Credentials:        credentials,
			WebhookCredentials: webhookCredentials,
			DeclineMap:         r.declineMaps["solidgate"],
		})
		r.cache[pspAccount.ID] = adapter
		return adapter, nil

	case "paypal":
		credentials, err := paypal.ResolveCredentials(r.config.PayPal, paypal.PspAccount{
			Mode:      pspAccount.Mode,
			SecretRef: pspAccount.SecretRef,
		})
		if err != nil {
			return nil, err
		}
		adapter := paypal.New(paypal.Options{
			Credentials: credentials,
			DeclineMap:  r.declineMaps["paypal"],
		})
		r.cache[pspAccount.ID] = adapter
		return adapter, nil

	default:
		return nil, &UnknownPspError{PSP: pspAccount.PSP}
	}
}
