package api

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// This file is a 1:1 port of src/api/routes/customers.ts.

// CustomersStore is the minimal persistence capability
// GET /v1/customers/:id/payment-methods needs — the Go analogue of the
// TS route's two `deps.db` calls (look up the customer scoped by
// merchant_entity_id, then list its active payment methods).
//
// NOT YET IMPLEMENTED for real in this phase — see payments.go's top
// doc comment for the same rationale (no pgx/DB layer exists yet).
// cmd/api/main.go wires a stub returning ErrNotImplemented.
type CustomersStore interface {
	// FindCustomer returns true if a customer with this id exists AND
	// belongs to merchantEntityID — scoped by merchant_entity_id, not
	// product_id, matching the TS route's own comment: "payment methods
	// are shared across every product under the same legal entity."
	FindCustomer(ctx context.Context, id string, merchantEntityID string) (bool, error)
	// ListActivePaymentMethods returns every payment_methods row for
	// customerID with is_active = true.
	ListActivePaymentMethods(ctx context.Context, customerID string) ([]PaymentMethodRow, error)
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
// Go analogue of registerCustomersRoutes(app, deps).
func registerCustomersRoutes(r chi.Router, deps CustomersRouteDeps) {
	r.Get("/customers/{id}/payment-methods", handleListPaymentMethods(deps))
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
