// Command migrate applies (or rolls back) this project's Postgres
// migrations using golang-migrate against db/migrations — the Go
// port's analogue of the TS backend's `migrate:up`, which that
// backend's Dockerfile CMD ran at container boot (see this repo's git
// history: "backend: run migrate:up as part of container boot (CMD),
// not a manual Console exec" — that same lesson (don't require a
// human to remember a manual migration step after every deploy)
// applies here, hence deploy/Dockerfile.api's CMD running this binary
// before starting cmd/api).
//
// This did not exist anywhere in this Go port before this fix pass:
// internal/migrations previously only had a structural test
// (migrations_test.go, which parses db/migrations and enumerates
// version pairs without ever touching a live database — see that
// file's own top comment). This command is the first code in this
// port that actually calls `migrate.Up`/`migrate.Down` against a real
// Postgres connection.
//
// Usage:
//
//	migrate up          # apply every pending migration (default if no arg given)
//	migrate down 1       # roll back exactly N steps
//	migrate version      # print the current schema version
//
// Reads DATABASE_URL directly from the environment rather than going
// through internal/config.Load(), deliberately: config.Load()
// validates HATCHET_CLIENT_TOKEN/STRIPE_*/SOLIDGATE_* as required
// (see internal/config/config.go), none of which this command needs —
// requiring them here would make `migrate` fail in exactly the
// deploy-step context (a dedicated Railway pre-deploy command, or a
// standalone one-off container) where those other services' secrets
// may not even be relevant yet.
package main

import (
	"errors"
	"fmt"
	"os"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
)

const migrationsDir = "file://db/migrations"

func main() {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		fmt.Fprintln(os.Stderr, "migrate: DATABASE_URL is not set")
		os.Exit(1)
	}

	m, err := migrate.New(migrationsDir, databaseURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "migrate: failed to initialize: %v\n", err)
		os.Exit(1)
	}
	defer func() {
		srcErr, dbErr := m.Close()
		if srcErr != nil {
			fmt.Fprintf(os.Stderr, "migrate: error closing source: %v\n", srcErr)
		}
		if dbErr != nil {
			fmt.Fprintf(os.Stderr, "migrate: error closing database: %v\n", dbErr)
		}
	}()

	args := os.Args[1:]
	command := "up"
	if len(args) > 0 {
		command = args[0]
	}

	switch command {
	case "up":
		runMigrate(m.Up())
	case "down":
		steps := 1
		if len(args) > 1 {
			if _, err := fmt.Sscanf(args[1], "%d", &steps); err != nil {
				fmt.Fprintf(os.Stderr, "migrate: invalid step count %q: %v\n", args[1], err)
				os.Exit(1)
			}
		}
		runMigrate(m.Steps(-steps))
	case "version":
		version, dirty, err := m.Version()
		if err != nil {
			fmt.Fprintf(os.Stderr, "migrate: failed to read version: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("version=%d dirty=%v\n", version, dirty)
	default:
		fmt.Fprintf(os.Stderr, "migrate: unknown command %q (want up|down|version)\n", command)
		os.Exit(1)
	}
}

// runMigrate treats migrate.ErrNoChange (nothing pending) as success —
// exactly the case every redeploy hits once the schema is already
// current, which must NOT fail the container boot.
func runMigrate(err error) {
	if err != nil && !errors.Is(err, migrate.ErrNoChange) {
		fmt.Fprintf(os.Stderr, "migrate: failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("migrate: ok")
}
