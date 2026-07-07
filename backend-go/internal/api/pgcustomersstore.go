package api

import (
	"context"
	"errors"
	"fmt"

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

// customerColumns is the exact column list every customers SELECT in
// this file uses, matching pgpaymentsstore.go's paymentColumns
// convention so a single scan helper can be shared.
const customerColumns = `id, merchant_entity_id, external_ref, email, created_at, updated_at`

func scanCustomerRow(row pgx.Row) (CustomerRow, error) {
	var c CustomerRow
	err := row.Scan(&c.ID, &c.MerchantEntityID, &c.ExternalRef, &c.Email, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return CustomerRow{}, err
	}
	return c, nil
}

// ListCustomers implements CustomersStore.ListCustomers — added
// 2026-07-07 alongside GET /v1/customers (see customers.go's top doc
// comment for why this route didn't exist before). Scoped by
// merchant_entity_id, exactly matching this file's own FindCustomer
// above (customers have no product_id column at all — see the
// core-schema migration). Keyset-paginated by id, mirroring
// PgxPaymentsStore.ListPayments (pgpaymentsstore.go) as closely as the
// narrower query surface allows: no filters exist yet beyond
// merchant scoping + cursor, since there is no established TS source
// to port filter behavior from for this endpoint (unlike ListPayments,
// which is a 1:1 port).
func (s PgxCustomersStore) ListCustomers(ctx context.Context, merchantEntityID string, query ListCustomersQuery) ([]CustomerRow, error) {
	sql := `SELECT ` + customerColumns + ` FROM customers WHERE merchant_entity_id = $1`
	args := []any{merchantEntityID}

	if query.Cursor != nil {
		args = append(args, *query.Cursor)
		sql += fmt.Sprintf(" AND id < $%d", len(args))
	}

	limit := query.Limit
	if limit <= 0 {
		limit = 20
	}
	args = append(args, limit+1)
	sql += fmt.Sprintf(" ORDER BY id DESC LIMIT $%d", len(args))

	rows, err := s.Pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("api: query customers list: %w", err)
	}
	defer rows.Close()

	var out []CustomerRow
	for rows.Next() {
		c, err := scanCustomerRow(rows)
		if err != nil {
			return nil, fmt.Errorf("api: scan customers list row: %w", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("api: iterate customers list rows: %w", err)
	}
	return out, nil
}
