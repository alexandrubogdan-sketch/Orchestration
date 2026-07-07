package api

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PgxCustomersStore is the real, pgx-backed CustomersStore — the Go
// port of the two Kysely queries src/api/routes/customers.ts's handler
// makes directly. Wired for real in cmd/api/main.go, replacing Phase
// 3/4's UnimplementedCustomersStore{}.
type PgxCustomersStore struct {
	Pool *pgxpool.Pool
}

// FindCustomer mirrors the TS route's
// `db.selectFrom('customers').select('id').where('id','=',id).where('merchant_entity_id','=',merchantEntityId).executeTakeFirst()`
// — scoped by merchant_entity_id (payment methods are shared across
// every product under the same legal entity, per this interface's own
// doc comment in customers.go), not product_id.
func (s PgxCustomersStore) FindCustomer(ctx context.Context, id string, merchantEntityID string) (bool, error) {
	var found string
	err := s.Pool.QueryRow(ctx,
		`SELECT id FROM customers WHERE id = $1 AND merchant_entity_id = $2`,
		id, merchantEntityID,
	).Scan(&found)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// ListActivePaymentMethods mirrors the TS route's
// `db.selectFrom('payment_methods').selectAll().where('customer_id','=',customerId).where('is_active','=',true).execute()`.
// card_brand/card_last4 are nullable columns (per the core-schema
// migration: `card_brand text`, `card_last4 text`, no NOT NULL) —
// scanned directly into *string fields, which pgx v5 maps a SQL NULL
// into as a nil pointer without erroring (the same pattern
// PgxIdempotencyStore.Get and this file's PaymentMethodRow scanning
// elsewhere in this package already rely on).
func (s PgxCustomersStore) ListActivePaymentMethods(ctx context.Context, customerID string) ([]PaymentMethodRow, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT id, type, card_brand, card_last4, is_active, created_at, psp_payment_method_ref
		 FROM payment_methods
		 WHERE customer_id = $1 AND is_active = true
		 ORDER BY created_at ASC`,
		customerID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []PaymentMethodRow
	for rows.Next() {
		var r PaymentMethodRow
		if err := rows.Scan(&r.ID, &r.Type, &r.CardBrand, &r.CardLast4, &r.IsActive, &r.CreatedAt, &r.PspPaymentMethodRef); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
