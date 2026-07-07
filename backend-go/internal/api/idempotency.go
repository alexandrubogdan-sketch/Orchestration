package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// Client -> API idempotency (Non-negotiable #4). A 1:1 port of
// src/api/idempotency.ts. The database is the source of truth
// (Non-negotiable #2: "idempotency... enforced with DB transactions
// and unique constraints, not application memory") —
// idempotency_keys.key is a primary key, so whichever concurrent
// request's INSERT wins the race is the one that actually runs the
// handler; every other concurrent (or later) request for the same key
// waits for that row to complete and replays its stored response.
// Redis is a read-through cache for already-completed keys only, to
// keep hot replay traffic off Postgres — it is never the thing that
// decides who "wins," only an optimization once a winner is known.
const (
	responseCacheTTL = 24 * time.Hour // matches typical PSP idempotency-key windows
	pollInterval      = 50 * time.Millisecond
	pollTimeout        = 10 * time.Second
)

// IdempotencyConflictError mirrors the TS IdempotencyConflictError —
// the same Idempotency-Key was reused with a different request body.
// Maps to HTTP 409 at the route layer (see server.ts's
// setErrorHandler; this Go port's routes check for this error type
// directly and return 409 themselves, since there is no shared
// central error handler — see router.go's BuildRouter doc comment).
type IdempotencyConflictError struct {
	Key string
}

func (e *IdempotencyConflictError) Error() string {
	return `Idempotency-Key "` + e.Key + `" was already used with a different request body`
}

// IdempotencyStillInProgressError mirrors the TS
// IdempotencyStillInProgressError — either genuinely still running
// past the poll timeout, or the blocking row disappeared out from
// under a poller (the original attempt failed before completing,
// e.g. process crash) and the caller should retry the whole operation
// from scratch. Maps to HTTP 409, same as IdempotencyConflictError.
type IdempotencyStillInProgressError struct {
	Key string
}

func (e *IdempotencyStillInProgressError) Error() string {
	return `Idempotency-Key "` + e.Key + `" is still being processed by another request`
}

// MissingIdempotencyKeyError mirrors the TS MissingIdempotencyKeyError.
// Maps to HTTP 400.
type MissingIdempotencyKeyError struct{}

func (e *MissingIdempotencyKeyError) Error() string {
	return "Idempotency-Key header is required for this request"
}

// RequireIdempotencyKey extracts and validates the Idempotency-Key
// header exactly as src/api/idempotency.ts's requireIdempotencyKey
// does: takes the FIRST value if the header was somehow sent multiple
// times (net/http's r.Header.Get already does this — Go's http.Header
// stores multiple values per key and .Get returns the first), and
// requires the trimmed value to be non-empty.
func RequireIdempotencyKey(header http.Header) (string, error) {
	value := header.Get("Idempotency-Key")
	if strings.TrimSpace(value) == "" {
		return "", &MissingIdempotencyKeyError{}
	}
	return value, nil
}

// IdempotentRequestDescriptor mirrors the TS IdempotentRequestDescriptor.
type IdempotentRequestDescriptor struct {
	Method string
	Path   string
	Body   any
}

// IdempotentResult mirrors the TS IdempotentResult.
type IdempotentResult struct {
	Status int
	Body   any
}

// IdempotentOutcome mirrors the TS IdempotentOutcome — IdempotentResult
// plus Replayed, true if this response came from a prior completed
// request rather than a fresh execution.
type IdempotentOutcome struct {
	IdempotentResult
	Replayed bool
}

// ComputeRequestHash mirrors src/api/idempotency.ts's
// computeRequestHash EXACTLY, including field order and null-coalescing:
//
//	JSON.stringify({ method: METHOD.toUpperCase(), path, body: body ?? null })
//
// then SHA-256 hex digest. Field order matters because this is fed
// into JSON serialization before hashing, and Go's encoding/json
// serializes struct fields in declaration order (not alphabetically),
// so canonicalRequest below declares Method/Path/Body in exactly that
// order to reproduce the identical byte sequence the TS
// JSON.stringify({method, path, body}) call literal produces.
// request.Body of nil serializes to JSON `null`, matching the TS
// `body ?? null` — this is why "undefined and null body hash the
// same" (see the TS unit test of the same name): in Go, an untyped nil
// interface value passed as Body marshals to `null` either way, so
// there is no separate "undefined" case to reconcile at all.
func ComputeRequestHash(request IdempotentRequestDescriptor) (string, error) {
	canonical := struct {
		Method string `json:"method"`
		Path   string `json:"path"`
		Body   any    `json:"body"`
	}{
		Method: strings.ToUpper(request.Method),
		Path:   request.Path,
		Body:   request.Body,
	}
	// canonical.Body left as nil marshals to JSON `null`, matching the
	// TS `body ?? null` — no separate branch needed.
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

// idempotencyKeyStatus mirrors the TS idempotency_keys.status CHECK
// constraint values exactly.
type idempotencyKeyStatus string

const (
	idempotencyStatusInProgress idempotencyKeyStatus = "in_progress"
	idempotencyStatusCompleted  idempotencyKeyStatus = "completed"
)

// IdempotencyKeyRow mirrors the columns withIdempotencyKey's
// pollForCompletion selects from idempotency_keys.
type IdempotencyKeyRow struct {
	RequestHash    string
	Status         idempotencyKeyStatus
	ResponseStatus int
	// ResponseBody is the raw JSON previously stored — already-decoded
	// into `any` by the store's Get, matching the TS row.response_body
	// jsonb column, which Kysely/pg decode into a JS value automatically.
	ResponseBody any
}

// ErrIdempotencyKeyNotFound is returned by IdempotencyStore.Get when no
// row exists for a key — used by pollForCompletion to detect "the
// blocking row disappeared" (see IdempotencyStillInProgressError's doc
// comment).
var ErrIdempotencyKeyNotFound = errors.New("idempotency key not found")

// ErrIdempotencyKeyExists is returned by IdempotencyStore.Insert when
// a row for that key already exists — the Go analogue of node-postgres
// surfacing Postgres error code 23505 (unique_violation) on
// idempotency_keys.key's primary-key constraint. A real pgx-backed
// implementation should return this exact sentinel (wrapped or not,
// callers use errors.Is) whenever the underlying INSERT hits that
// constraint — see this file's IdempotencyStore doc comment.
var ErrIdempotencyKeyExists = errors.New("idempotency key already exists")

// IdempotencyStore is the minimal capability withIdempotencyKey needs
// from Postgres — the Go analogue of the TS `deps.db` calls against
// the idempotency_keys table (insertInto/selectFrom/updateTable/
// deleteFrom), narrowed to an interface so this package's tests never
// need a live Postgres.
//
// A real pgx-backed implementation (PgxIdempotencyStore) lives in
// internal/api/pgstore.go and IS wired for real in cmd/api/main.go —
// the idempotency_keys table has no dependency on the routing engine
// or any other later phase. internal/api/stubs.go's
// UnavailableIdempotencyStore remains available as an
// always-ErrNotImplemented fallback for tests or callers without a DB.
type IdempotencyStore interface {
	// Insert attempts to create the in_progress row. Returns
	// ErrIdempotencyKeyExists if key already has a row (unique_violation
	// on the primary key), matching the TS isUniqueViolation(err) branch.
	Insert(ctx context.Context, key string, requestHash string) error
	// Get returns the current row for key, or ErrIdempotencyKeyNotFound.
	Get(ctx context.Context, key string) (IdempotencyKeyRow, error)
	// Complete marks key's row completed with the given response,
	// matching the TS updateTable(...).set({status: 'completed', ...}).
	Complete(ctx context.Context, key string, responseStatus int, responseBody any) error
	// Delete removes key's row entirely, matching the TS
	// deleteFrom('idempotency_keys').where('key', '=', key) call made
	// when handler() throws — so the key isn't permanently wedged.
	Delete(ctx context.Context, key string) error
}

// cachedResult is the exact shape stored in Redis (JSON-encoded) by
// both the winning path and the poll-then-cache path — mirrors the TS
// `{ requestHash, result }` object stored via
// JSON.stringify({ requestHash, result }).
type cachedResult struct {
	RequestHash string           `json:"requestHash"`
	Result      IdempotentResult `json:"result"`
}

// IdempotencyCache is the minimal capability withIdempotencyKey needs
// from Redis — a read-through cache keyed by
// "idempotency:response:{key}" (cacheKeyFor in the TS source),
// narrowed to an interface for the same DB-independence reason as
// IdempotencyStore. A real implementation (RedisIdempotencyCache) lives
// in internal/api/infra.go, wrapping a *redis.Client's GET/SET calls
// directly, and IS wired for real in cmd/api/main.go. The interface
// itself, and WithIdempotencyKey's use of it, is exercised by
// idempotency_test.go against a small in-memory fake.
type IdempotencyCache interface {
	// Get returns the raw cached JSON value for key, and false if
	// absent — the Go analogue of `await deps.redis.get(cacheKeyFor(key))`
	// returning null.
	Get(ctx context.Context, key string) (string, bool, error)
	// Set stores value for key with the given TTL — the Go analogue of
	// `await deps.redis.set(cacheKeyFor(key), value, 'EX', ttlSeconds)`.
	Set(ctx context.Context, key string, value string, ttl time.Duration) error
}

func cacheKeyFor(key string) string {
	return "idempotency:response:" + key
}

// IdempotencyDeps mirrors the TS IdempotencyDeps interface.
type IdempotencyDeps struct {
	Store IdempotencyStore
	Cache IdempotencyCache
}

// pollForCompletion mirrors src/api/idempotency.ts's pollForCompletion
// exactly: polls IdempotencyStore.Get every pollInterval until the row
// is completed or pollTimeout elapses, and treats a disappeared row
// (ErrIdempotencyKeyNotFound) as "the original attempt failed before
// completing — the caller should retry the whole operation, which will
// now win the insert race itself" by returning
// IdempotencyStillInProgressError immediately rather than continuing
// to poll for a row that no longer exists.
func pollForCompletion(ctx context.Context, store IdempotencyStore, key string) (IdempotencyKeyRow, error) {
	deadline := time.Now().Add(pollTimeout)
	for {
		row, err := store.Get(ctx, key)
		if err != nil {
			if errors.Is(err, ErrIdempotencyKeyNotFound) {
				return IdempotencyKeyRow{}, &IdempotencyStillInProgressError{Key: key}
			}
			return IdempotencyKeyRow{}, err
		}

		if row.Status == idempotencyStatusCompleted {
			return row, nil
		}

		if time.Now().After(deadline) {
			return IdempotencyKeyRow{}, &IdempotencyStillInProgressError{Key: key}
		}

		select {
		case <-ctx.Done():
			return IdempotencyKeyRow{}, ctx.Err()
		case <-time.After(pollInterval):
		}
	}
}

// WithIdempotencyKey runs handler exactly once for a given
// Idempotency-Key, regardless of how many concurrent/retried requests
// arrive with that key — a 1:1 port of src/api/idempotency.ts's
// withIdempotencyKey:
//
//   - First checks the Redis cache; a cache hit with a matching request
//     hash replays immediately without touching Postgres at all
//     (matching the TS source's cache-check-first ordering exactly —
//     this is the ONE path that can return a cached replay without ever
//     inserting/reading idempotency_keys).
//   - A cache hit with a DIFFERENT request hash is a conflict,
//     returned immediately — even before touching Postgres, matching
//     the TS `if (parsed.requestHash !== requestHash) throw new
//     IdempotencyConflictError(key)` branch inside the `if (cached)`
//     block.
//   - Otherwise, attempts to INSERT the in_progress row. Whichever
//     concurrent caller's INSERT succeeds runs handler() for real. Every
//     other caller (ErrIdempotencyKeyExists) polls for that row to
//     complete via pollForCompletion, then either replays its result
//     (matching request hash) or returns IdempotencyConflictError
//     (mismatched hash) — populating the Redis cache in the poll-hit
//     case too, exactly matching the TS source's redundant-looking but
//     deliberate `await deps.redis.set(...)` call inside that branch.
//   - If handler() itself returns an error, the in_progress row is
//     deleted (so the key isn't permanently wedged — a subsequent retry
//     with the same key gets a fresh attempt) and the error is returned
//     to the caller as-is, matching the TS `catch (err) { await
//     deps.db.deleteFrom(...); throw err; }` block exactly (no error
//     wrapping).
//   - On success, the row is marked completed and the result is cached
//     in Redis with the same TTL as every other cache-write path.
func WithIdempotencyKey(
	ctx context.Context,
	deps IdempotencyDeps,
	key string,
	request IdempotentRequestDescriptor,
	handler func(ctx context.Context) (IdempotentResult, error),
) (IdempotentOutcome, error) {
	requestHash, err := ComputeRequestHash(request)
	if err != nil {
		return IdempotentOutcome{}, err
	}

	if deps.Cache != nil {
		cachedRaw, found, err := deps.Cache.Get(ctx, cacheKeyFor(key))
		if err != nil {
			return IdempotentOutcome{}, err
		}
		if found {
			var parsed cachedResult
			if err := json.Unmarshal([]byte(cachedRaw), &parsed); err != nil {
				return IdempotentOutcome{}, err
			}
			if parsed.RequestHash != requestHash {
				return IdempotentOutcome{}, &IdempotencyConflictError{Key: key}
			}
			return IdempotentOutcome{IdempotentResult: parsed.Result, Replayed: true}, nil
		}
	}

	insertErr := deps.Store.Insert(ctx, key, requestHash)
	if insertErr != nil {
		if !errors.Is(insertErr, ErrIdempotencyKeyExists) {
			return IdempotentOutcome{}, insertErr
		}

		row, err := pollForCompletion(ctx, deps.Store, key)
		if err != nil {
			return IdempotentOutcome{}, err
		}
		if row.RequestHash != requestHash {
			return IdempotentOutcome{}, &IdempotencyConflictError{Key: key}
		}

		result := IdempotentResult{Status: row.ResponseStatus, Body: row.ResponseBody}
		if deps.Cache != nil {
			if cacheErr := setCachedResult(ctx, deps.Cache, key, requestHash, result); cacheErr != nil {
				return IdempotentOutcome{}, cacheErr
			}
		}
		return IdempotentOutcome{IdempotentResult: result, Replayed: true}, nil
	}

	result, err := handler(ctx)
	if err != nil {
		// Best-effort delete — matches the TS source's unconditional
		// `await deps.db.deleteFrom(...)` (it does not itself guard
		// against a delete failure), so this Go port does not either;
		// a delete failure here is surfaced instead of the original
		// handler error only if the delete itself errors, mirroring
		// that an unhandled TS promise rejection from the delete call
		// would likewise propagate instead of the original error.
		if delErr := deps.Store.Delete(ctx, key); delErr != nil {
			return IdempotentOutcome{}, delErr
		}
		return IdempotentOutcome{}, err
	}

	if err := deps.Store.Complete(ctx, key, result.Status, result.Body); err != nil {
		return IdempotentOutcome{}, err
	}

	if deps.Cache != nil {
		if cacheErr := setCachedResult(ctx, deps.Cache, key, requestHash, result); cacheErr != nil {
			return IdempotentOutcome{}, cacheErr
		}
	}

	return IdempotentOutcome{IdempotentResult: result, Replayed: false}, nil
}

func setCachedResult(ctx context.Context, cache IdempotencyCache, key string, requestHash string, result IdempotentResult) error {
	encoded, err := json.Marshal(cachedResult{RequestHash: requestHash, Result: result})
	if err != nil {
		return err
	}
	return cache.Set(ctx, cacheKeyFor(key), string(encoded), responseCacheTTL)
}
