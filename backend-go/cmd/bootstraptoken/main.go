// Command bootstraptoken mints one real, usable API token against
// whatever Postgres DATABASE_URL points at — added 2026-07-07
// specifically to unblock the sibling frontend's Live mode: the raw
// token generateApiToken()/GenerateAPIToken() produces is SHA-256
// hashed at rest (see internal/api/auth.go) and shown to the caller
// exactly once, at creation, by design (see the TS reference's own
// scripts/seed.ts, which this command's token-creation logic mirrors
// closely) — there is no way to recover a lost raw token, and no
// evidence any earlier raw token from this project's history survived
// anywhere retrievable (checked: the deployed Vercel frontend project
// has zero environment variables configured, so it was never handed
// one either). Rather than trying to reconstruct a lost secret, this
// command creates a fresh one.
//
// Reuses whatever merchant_entity/product rows already exist (falling
// back to the TS seed script's own "US-LLC" legal_entity_code first,
// matching the frontend sidebar's "US-LLC & EU-BV" label, then any
// other entity, then creating one from scratch only if the database is
// completely empty) rather than requiring the caller to already know a
// product id — this command is meant to be run once, by hand, via
// Railway's Console tab against the deployed api service
// (`./bootstraptoken`), by someone who has no other way to look up
// existing ids at that point.
//
// Idempotency is deliberately NOT attempted the way cmd/migrate's
// up/down commands are idempotent: every run inserts a new api_tokens
// row and prints a new raw token. Running this twice produces two
// valid tokens, not an error — simpler and safer than trying to detect
// "does a usable token already exist" (a hash can't be reversed to
// check that, and merely counting rows in api_tokens doesn't tell you
// whether any earlier raw token was ever actually retained by anyone).
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alphapayments/payment-orchestrator/internal/api"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "bootstraptoken: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		return fmt.Errorf("DATABASE_URL is not set")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("connect to database: %w", err)
	}
	defer pool.Close()

	entityID, entityLabel, err := findOrCreateMerchantEntity(ctx, pool)
	if err != nil {
		return fmt.Errorf("resolve merchant entity: %w", err)
	}

	productID, productLabel, err := findOrCreateProduct(ctx, pool, entityID)
	if err != nil {
		return fmt.Errorf("resolve product: %w", err)
	}

	raw, hash, err := api.GenerateAPIToken()
	if err != nil {
		return fmt.Errorf("generate token: %w", err)
	}

	tokenID, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("generate token id: %w", err)
	}

	_, err = pool.Exec(ctx,
		`INSERT INTO api_tokens (id, product_id, merchant_entity_id, token_hash, description)
		 VALUES ($1, $2, $3, $4, $5)`,
		tokenID.String(), productID, entityID, hash,
		"Bootstrapped 2026-07-07 for the frontend's Live-mode proxy routes",
	)
	if err != nil {
		return fmt.Errorf("insert api_tokens row: %w", err)
	}

	fmt.Printf("Bootstrapped an API token for entity %q, product %q.\n", entityLabel, productLabel)
	fmt.Printf("\nAPI token (save this now — it is never shown again):\n\n  %s\n\n", raw)
	fmt.Println("Set this as BACKEND_API_TOKEN in the frontend's environment.")
	return nil
}

// findOrCreateMerchantEntity prefers the TS seed script's own
// "US-LLC" legal_entity_code (matching the frontend sidebar's
// "US-LLC & EU-BV" label), falls back to any existing entity, and
// only creates a new one if the table is completely empty.
func findOrCreateMerchantEntity(ctx context.Context, pool *pgxpool.Pool) (id string, label string, err error) {
	row := pool.QueryRow(ctx,
		`SELECT id, name FROM merchant_entities WHERE legal_entity_code = 'US-LLC' LIMIT 1`)
	if err := row.Scan(&id, &label); err == nil {
		return id, label, nil
	}

	row = pool.QueryRow(ctx, `SELECT id, name FROM merchant_entities ORDER BY created_at ASC LIMIT 1`)
	if err := row.Scan(&id, &label); err == nil {
		return id, label, nil
	}

	newID, err := uuid.NewV7()
	if err != nil {
		return "", "", err
	}
	const name = "Progress Partners (bootstrap)"
	_, err = pool.Exec(ctx,
		`INSERT INTO merchant_entities (id, name, legal_entity_code) VALUES ($1, $2, 'BOOTSTRAP')`,
		newID.String(), name,
	)
	if err != nil {
		return "", "", err
	}
	return newID.String(), name, nil
}

// findOrCreateProduct prefers any existing product already scoped to
// entityID, falling back to creating one only if that entity has none.
func findOrCreateProduct(ctx context.Context, pool *pgxpool.Pool, entityID string) (id string, label string, err error) {
	row := pool.QueryRow(ctx,
		`SELECT id, name FROM products WHERE merchant_entity_id = $1 ORDER BY created_at ASC LIMIT 1`,
		entityID,
	)
	if err := row.Scan(&id, &label); err == nil {
		return id, label, nil
	}

	newID, err := uuid.NewV7()
	if err != nil {
		return "", "", err
	}
	const name = "Bootstrap Product"
	_, err = pool.Exec(ctx,
		`INSERT INTO products (id, merchant_entity_id, name, slug) VALUES ($1, $2, $3, 'bootstrap-product')`,
		newID.String(), entityID, name,
	)
	if err != nil {
		return "", "", err
	}
	return newID.String(), name, nil
}
