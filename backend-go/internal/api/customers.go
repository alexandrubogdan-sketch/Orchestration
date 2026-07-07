package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
)

// This file is a 1:1 port of src/api/routes/customers.ts, PLUS one
// route the TS source never had: GET /v1/customers (list). This was
// added 2026-07-07, after the checkout/payments proxy routes exposed
// that the real client's Customers page has no backing endpoint at
// all on this Go port — every other /v1/* resource this port exposes
// (payments, plans, retry-settings) has a list route; customers only
// ever had the single-customer payment-methods lookup below. Added
// following the same "1:1 port of the TS shapes" discipline as every
// other handler in this file: no TS source exists for this one, so it
// is designed from this package's own established ListPayments
// pattern instead (keyset pagination by id, {data, pagination}
// envelope, same query-param names) — see ListCustomers's doc comment
// on PgxCustomersStore for the exact SQL. See MIGRATION_NOTES.md's
// dated section for the fuller writeup of why this was missing and
// what it does/doesn't cover (in particular: the `customers` table
// itself only has id/external_ref/email/created_at/updated_at — no
// name, address, or subscription columns, so this DTO cannot expose
// those fields the way the frontend's mock data does; see that section
// for the explicit list of what is NOT covered here).

// CustomersStore is the minimal persistence capability the
// /v1/customers* routes need — the Go analogue of the TS route's
// `deps.db` calls (look up the customer scoped by merchant_entity_id,
// list its active payment methods, list customers scoped by
// merchant_entity_id).
//
// FindCustomer/ListActivePaymentMethods NOT YET IMPLEMENTED for real
// in this phase — see payments.go's top doc comment for the same
// rationale (no pgx/DB layer exists yet). cmd/api/main.go wires a stub
// returning ErrNotImplemented. ListCustomers (added 2026-07-07) DOES
// have a real, pgx-backed implementation (PgxCustomersStore.ListCustomers
// in pgcustomersstore.go) from the moment it was added, following this
// port's Phase-5-onward convention of wiring new store methods for
// real rather than stubbing them — there was never an "unimplemented"
// era for this one method.
type CustomersStore interface {
	// FindCustomer returns true if a customer with this id exists AND
	// belongs to merchantEntityID — scoped by merchant_entity_id, not
	// product_id, matching the TS route's own comment: "payment methods
	// are shared across every product under the same legal entity."
	FindCustomer(ctx context.Context, id string, merchantEntityID string) (bool, error)
	// ListActivePaymentMethods returns every payment_methods row for
	// customerID with is_active = true.
	ListActivePaymentMethods(ctx context.Context, customerID string) ([]PaymentMethodRow, error)
	// ListCustomers returns customers rows scoped by merchantEntityID —
	// the same merchant-entity scoping FindCustomer already uses, not
	// product_id (this table has no product_id column at all; a
	// customer's payment methods/subscriptions are shared across every
	// product under the same legal entity, per this interface's own
	// established comment above). Keyset-paginated by id exactly like
	// PaymentsStore.ListPayments — see that method's doc comment in
	// payments.go for why `id < cursor ORDER BY id DESC` is a safe,
	// stable cursor for this codebase's UUIDv7 primary keys. Returns
	// query.Limit+1 rows so the handler can compute hasMore/nextCursor,
	// matching ListPayments' own division of labor (this store method
	// does NOT trim to Limit itself).
	ListCustomers(ctx context.Context, merchantEntityID string, query ListCustomersQuery) ([]CustomerRow, error)
}

// CustomerRow mirrors the customers table's exact columns (core-schema
// migration) — no more, no less. Notably absent relative to the
// frontend's mock Customer type (lib/types.ts in
// payment-orchestrator-frontend): firstName/lastName, address,
// subscription. Those are frontend-only demo fields with no backing
// column anywhere in this schema; ListCustomers/CustomerDTO cannot
// invent them, so a Live-mode Customers page built against this
// endpoint will show fewer fields than the Sandbox/demo page does
// until a future migration adds them (flagged explicitly, not silently
// glossed over — see this file's top doc comment).
type CustomerRow struct {
	ID               string
	MerchantEntityID string
	ExternalRef      *string
	Email            *string
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// CustomerDTO mirrors CustomerRow's wire shape — field names/casing
// follow this package's established camelCase JSON convention
// (PaymentDTO, PaymentMethodDTO, etc.).
type CustomerDTO struct {
	ID          string  `json:"id"`
	ExternalRef *string `json:"externalRef,omitempty"`
	Email       *string `json:"email,omitempty"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
}

func serializeCustomer(c CustomerRow) CustomerDTO {
	return CustomerDTO{
		ID:          c.ID,
		ExternalRef: c.ExternalRef,
		Email:       c.Email,
		CreatedAt:   c.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:   c.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

// ListCustomersQuery mirrors ListPaymentsQuery's shape (payments.go),
// narrowed to what a customers list actually supports: cursor +
// limit, no filters yet (no obvious equivalent to payments' state/
// customerId/created-at-range filters exists for this resource today).
type ListCustomersQuery struct {
	Cursor *string
	Limit  int
}

// ListCustomersResponse mirrors ListPaymentsResponse's exact envelope
// shape: {"data": [...], "pagination": {"hasMore", "nextCursor"}}.
type ListCustomersResponse struct {
	Data       []CustomerDTO     `json:"data"`
	Pagination ListPaginationDTO `json:"pagination"`
}

// CustomersRouteDeps mirrors the TS CustomersRouteDeps interface.
type CustomersRouteDeps struct {
	Store CustomersStore
}

// PaymentMethodsResponse mirrors the TS route's exact response shape:
// {"data": [...]}.
type PaymentMethodsResponse struct {
	Data []PaymentMethodDTO `json:"data"`
}

// registerCustomersRoutes registers every /v1/customers* route — the
// Go analogue of registerCustomersRoutes(app, deps), extended
// 2026-07-07 with GET /v1/customers (list) — see this file's top doc
// comment for why. Registered before the {id}/payment-methods route
// only for readability (chi's radix-tree routing does not depend on
// registration order between a literal "/customers" and a
// "/customers/{id}/..." pattern).
func registerCustomersRoutes(r chi.Router, deps CustomersRouteDeps) {
	r.Get("/customers", handleListCustomers(deps))
	r.Get("/customers/{id}/payment-methods", handleListPaymentMethods(deps))
}

// handleListCustomers implements GET /v1/customers — Bearer-
// authenticated like every other /v1/* route (registered inside
// router.go's r.Route("/v1", ...) group). Mirrors handleListPayments'
// exact shape (payments.go): parse query, fetch limit+1 rows, compute
// hasMore/nextCursor from whether the extra row came back, serialize.
func handleListCustomers(deps CustomersRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, _ := authFromContext(r.Context())

		query, err := parseListCustomersQuery(r.URL.Query())
		if err != nil {
			WriteProblem(w, http.StatusBadRequest, "Validation failed", err.Error())
			return
		}

		if deps.Store == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		rows, err := deps.Store.ListCustomers(r.Context(), auth.MerchantEntityID, query)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		hasMore := len(rows) > query.Limit
		page := rows
		if hasMore {
			page = rows[:query.Limit]
		}

		dtos := make([]CustomerDTO, 0, len(page))
		for _, c := range page {
			dtos = append(dtos, serializeCustomer(c))
		}

		var nextCursor *string
		if hasMore && len(page) > 0 {
			c := page[len(page)-1].ID
			nextCursor = &c
		}

		writeJSON(w, http.StatusOK, ListCustomersResponse{
			Data:       dtos,
			Pagination: ListPaginationDTO{HasMore: hasMore, NextCursor: nextCursor},
		})
	}
}

// parseListCustomersQuery mirrors parseListPaymentsQuery's exact
// validation rules (payments.go): an optional cursor string, and an
// optional limit that must be an integer in [1, 100] if present,
// defaulting to 20 (set inside PgxCustomersStore.ListCustomers, same
// as ListPayments' own default) — 0 here means "not specified."
func parseListCustomersQuery(values map[string][]string) (ListCustomersQuery, error) {
	get := func(key string) *string {
		if vs, ok := values[key]; ok && len(vs) > 0 && vs[0] != "" {
			v := vs[0]
			return &v
		}
		return nil
	}

	query := ListCustomersQuery{Cursor: get("cursor")}
	if limitStr := get("limit"); limitStr != nil {
		limit, err := strconv.Atoi(*limitStr)
		if err != nil || limit < 1 || limit > 100 {
			return ListCustomersQuery{}, errors.New("limit: must be an integer between 1 and 100")
		}
		query.Limit = limit
	}
	return query, nil
}

func handleListPaymentMethods(deps CustomersRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, _ := authFromContext(r.Context())
		id := chi.URLParam(r, "id")

		if deps.Store == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		found, err := deps.Store.FindCustomer(r.Context(), id, auth.MerchantEntityID)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}
		if !found {
			WriteProblem(w, http.StatusNotFound, "Customer not found", "")
			return
		}

		methods, err := deps.Store.ListActivePaymentMethods(r.Context(), id)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		dtos := make([]PaymentMethodDTO, 0, len(methods))
		for _, pm := range methods {
			dtos = append(dtos, SerializePaymentMethod(pm))
		}

		writeJSON(w, http.StatusOK, PaymentMethodsResponse{Data: dtos})
	}
}
