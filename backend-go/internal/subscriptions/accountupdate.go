// This file is the Go port of src/paymentMethods/applyAccountUpdate.ts,
// T8.3: applies one normalized account-updater notification to
// payment_methods (and, transitively, any subscription billing it).
//
// card_closed cancels every active/past_due subscription on that
// instrument outright — mirrors the hard-decline handling in the
// renewal dispatcher (retrying a confirmed-closed account is exactly
// as pointless as retrying a stolen-card decline).
//
// A card_updated WITH a new token (NewPspPaymentMethodRef) creates a
// fresh payment_methods row rather than mutating the existing one's
// psp_payment_method_ref in place — the OLD token remains a
// historically accurate record of what a given payment_attempts row
// actually charged (attempts reference payment_methods only
// indirectly, via the PSP-side ref captured at attempt time, but
// keeping the row itself immutable-in-spirit avoids ever rewriting
// what "this token" meant retroactively). network_transaction_id
// carries forward unchanged — Non-negotiable #9's MIT continuity
// survives a token reissue on the same physical card.
package subscriptions

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
)

type paymentMethodFullRow struct {
	ID                   string
	CustomerID           string
	Type                 string
	CardBrand            *string
	CardLast4            *string
	CardExpMonth         *int
	CardExpYear          *int
	NetworkTransactionID *string
}

// ApplyAccountUpdate mirrors applyAccountUpdate exactly.
func ApplyAccountUpdate(ctx context.Context, pool *pgxpool.Pool, pspAccountID string, update adapters.AccountUpdateRecord) error {
	var pm paymentMethodFullRow
	err := pool.QueryRow(ctx,
		`SELECT id, customer_id, type, card_brand, card_last4, card_exp_month, card_exp_year, network_transaction_id
		 FROM payment_methods WHERE psp_account_id = $1 AND psp_payment_method_ref = $2`,
		pspAccountID, update.PspPaymentMethodRef,
	).Scan(&pm.ID, &pm.CustomerID, &pm.Type, &pm.CardBrand, &pm.CardLast4, &pm.CardExpMonth, &pm.CardExpYear, &pm.NetworkTransactionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // not a payment method we know about — nothing to apply.
		}
		return fmt.Errorf("subscriptions: query payment_method for psp_account %s ref %s: %w", pspAccountID, update.PspPaymentMethodRef, err)
	}

	if update.Type == adapters.AccountUpdateTypeCardClosed {
		return applyCardClosed(ctx, pool, pm)
	}

	// card_updated
	if update.NewPspPaymentMethodRef != nil && *update.NewPspPaymentMethodRef != update.PspPaymentMethodRef {
		return applyCardReissued(ctx, pool, pspAccountID, pm, update)
	}

	// In-place update: same token, new expiry (or nothing new — a no-op update).
	expMonth := pm.CardExpMonth
	if update.NewCardExpMonth != nil {
		expMonth = update.NewCardExpMonth
	}
	expYear := pm.CardExpYear
	if update.NewCardExpYear != nil {
		expYear = update.NewCardExpYear
	}
	_, err = pool.Exec(ctx,
		`UPDATE payment_methods SET card_exp_month = $2, card_exp_year = $3, updated_at = now() WHERE id = $1`,
		pm.ID, expMonth, expYear,
	)
	if err != nil {
		return fmt.Errorf("subscriptions: in-place update payment_method %s: %w", pm.ID, err)
	}
	return nil
}

func applyCardClosed(ctx context.Context, pool *pgxpool.Pool, pm paymentMethodFullRow) error {
	_, err := pool.Exec(ctx,
		`UPDATE payment_methods SET is_active = false, updated_at = now() WHERE id = $1`,
		pm.ID,
	)
	if err != nil {
		return fmt.Errorf("subscriptions: deactivate payment_method %s (card_closed): %w", pm.ID, err)
	}

	rows, err := pool.Query(ctx,
		`SELECT id FROM subscriptions WHERE payment_method_id = $1 AND status IN ('active', 'past_due')`,
		pm.ID,
	)
	if err != nil {
		return fmt.Errorf("subscriptions: query affected subscriptions for payment_method %s: %w", pm.ID, err)
	}
	var subscriptionIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return fmt.Errorf("subscriptions: scan affected subscription row: %w", err)
		}
		subscriptionIDs = append(subscriptionIDs, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("subscriptions: iterate affected subscription rows: %w", err)
	}
	rows.Close()

	for _, id := range subscriptionIDs {
		if err := CancelSubscription(ctx, pool, id, "card_closed"); err != nil {
			return fmt.Errorf("subscriptions: cancel subscription %s (card_closed): %w", id, err)
		}
	}
	return nil
}

func applyCardReissued(ctx context.Context, pool *pgxpool.Pool, pspAccountID string, pm paymentMethodFullRow, update adapters.AccountUpdateRecord) error {
	newID, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("subscriptions: generate new payment_method id: %w", err)
	}

	expMonth := pm.CardExpMonth
	if update.NewCardExpMonth != nil {
		expMonth = update.NewCardExpMonth
	}
	expYear := pm.CardExpYear
	if update.NewCardExpYear != nil {
		expYear = update.NewCardExpYear
	}

	_, err = pool.Exec(ctx,
		`INSERT INTO payment_methods (
			id, customer_id, psp_account_id, psp_payment_method_ref, type,
			card_brand, card_last4, card_exp_month, card_exp_year, network_transaction_id
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		newID.String(), pm.CustomerID, pspAccountID, *update.NewPspPaymentMethodRef, pm.Type,
		pm.CardBrand, pm.CardLast4, expMonth, expYear, pm.NetworkTransactionID,
	)
	if err != nil {
		return fmt.Errorf("subscriptions: insert reissued payment_method for %s: %w", pm.ID, err)
	}

	_, err = pool.Exec(ctx,
		`UPDATE payment_methods SET is_active = false, updated_at = now() WHERE id = $1`,
		pm.ID,
	)
	if err != nil {
		return fmt.Errorf("subscriptions: deactivate superseded payment_method %s: %w", pm.ID, err)
	}

	_, err = pool.Exec(ctx,
		`UPDATE subscriptions SET payment_method_id = $2, updated_at = now()
		 WHERE payment_method_id = $1 AND status IN ('active', 'past_due')`,
		pm.ID, newID.String(),
	)
	if err != nil {
		return fmt.Errorf("subscriptions: repoint subscriptions from payment_method %s to %s: %w", pm.ID, newID.String(), err)
	}
	return nil
}
