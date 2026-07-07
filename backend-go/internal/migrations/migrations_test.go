// Package migrations contains a lightweight test that validates the
// db/migrations directory is well-formed golang-migrate input — every
// version has both an .up.sql and .down.sql file, filenames parse
// according to golang-migrate's {version}_{title}.{up,down}.sql
// convention, and the source driver can enumerate every migration
// without error.
//
// This does NOT apply the migrations against a live Postgres — no
// reachable Postgres was available in the sandbox this code was
// written in. See MIGRATION_NOTES.md for what mitigated that risk
// (careful manual transcription + this structural check) and what
// still needs a real `migrate up`/`migrate down` dry run before this
// is trusted in CI/staging.
package migrations

import (
	"testing"

	"github.com/golang-migrate/migrate/v4/source"
	_ "github.com/golang-migrate/migrate/v4/source/file"
)

// migrationsDir is relative to this package's own directory
// (internal/migrations) up to the repo root's db/migrations.
const migrationsDir = "file://../../db/migrations"

func TestMigrationsDirectory_ParsesAndEnumeratesCleanly(t *testing.T) {
	driver, err := source.Open(migrationsDir)
	if err != nil {
		t.Fatalf("source.Open(%q) error: %v", migrationsDir, err)
	}
	defer driver.Close()

	first, err := driver.First()
	if err != nil {
		t.Fatalf("driver.First() error: %v", err)
	}

	const wantFirstVersion uint = 1735776000000
	if first != wantFirstVersion {
		t.Fatalf("first migration version = %d, want %d", first, wantFirstVersion)
	}

	count := 1
	version := first
	for {
		next, err := driver.Next(version)
		if err != nil {
			break // source.ErrNotExist once we've walked past the last version.
		}
		version = next
		count++
		if count > 100 {
			t.Fatal("more than 100 migrations enumerated — probable infinite loop or directory corruption")
		}
	}

	// Checkout Sessions feature (2026-07-07): added
	// 1735777200000_checkout-sessions.{up,down}.sql as the 12th migration
	// pair — see MIGRATION_NOTES.md's Checkout Sessions section.
	//
	// Configurable retry/dunning policy feature (2026-07-07): added
	// 1735777300000_retry-settings.{up,down}.sql as the 13th migration
	// pair — see MIGRATION_NOTES.md's Configurable Retry/Dunning Policy
	// section.
	//
	// Plans resource feature (2026-07-07): added
	// 1735777400000_plans.{up,down}.sql as the 14th migration pair — see
	// MIGRATION_NOTES.md's Plans resource section. Caught during the
	// full-backend-audit verification pass: the Plans-building agent
	// added this migration but did not update this test, which would
	// have failed the moment a real Go toolchain ran it.
	const wantCount = 14
	if count != wantCount {
		t.Errorf("enumerated %d migrations, want %d", count, wantCount)
	}

	const wantLastVersion uint = 1735777400000
	if version != wantLastVersion {
		t.Errorf("last migration version = %d, want %d", version, wantLastVersion)
	}

	// Every version must have both an up and a down migration readable
	// via the source driver (ReadUp/ReadDown error if the file is
	// missing or malformed).
	v := first
	for {
		if upReader, _, err := driver.ReadUp(v); err != nil {
			t.Errorf("ReadUp(%d) error: %v", v, err)
		} else {
			upReader.Close()
		}
		if downReader, _, err := driver.ReadDown(v); err != nil {
			t.Errorf("ReadDown(%d) error: %v", v, err)
		} else {
			downReader.Close()
		}

		next, err := driver.Next(v)
		if err != nil {
			break
		}
		v = next
	}
}
