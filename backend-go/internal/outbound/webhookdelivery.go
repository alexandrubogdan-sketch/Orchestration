// Package outbound is the Go port of Milestone 8's outbound-webhook
// delivery: src/outbound/signature.ts (signing) and
// src/workflow/tasks/outboundWebhookDelivery.ts (the T8.4 outbox
// consumer that fans a payment-state-transition outbox event out to
// every enabled outbound_webhook_endpoints row for that event's
// product). This is the OUTBOX CONSUMER side for the
// 'outbound-webhook' event type — the producer side
// (internal/statemachine/db.go's insertOutboundWebhookOutboxRow) and
// the generic outbox-relay dispatcher (internal/worker/tasks.go's
// outbox-relay task, wrapping internal/outbox's producer-only package)
// already exist; this package is what the relay's
// `outbox.outbound-webhook` dispatch target actually runs.
package outbound

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// OutboundWebhookOutboxEventType mirrors
// OUTBOUND_WEBHOOK_OUTBOX_EVENT_TYPE exactly — duplicated here (rather
// than imported from internal/statemachine) as a plain string constant
// since it's a stable, two-word wire value, matching this port's
// existing precedent of duplicating tiny, extremely-stable constants
// across package boundaries rather than manufacturing an import purely
// to share one string literal (see internal/webhooks/inbox.go's
// pgUniqueViolationCode for the identical precedent).
const OutboundWebhookOutboxEventType = "outbound-webhook"

// MaxSignatureAgeMS mirrors MAX_SIGNATURE_AGE_MS exactly: 5 minutes —
// generous enough for delivery/retry jitter, tight enough to matter.
const MaxSignatureAgeMS = int64(5 * 60_000)

// GenerateWebhookSigningSecret mirrors generateWebhookSigningSecret
// exactly: a `whsec_`-prefixed, 24-random-byte hex string.
func GenerateWebhookSigningSecret() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("outbound: generate signing secret: %w", err)
	}
	return "whsec_" + hex.EncodeToString(buf), nil
}

// SignOutboundWebhook mirrors signOutboundWebhook exactly: deliberately
// mirrors Stripe's own `t=<timestamp>,v1=<hmac>` scheme — including the
// timestamp IN the signed payload defeats replay of a captured
// request, which a bare HMAC(secret, body) scheme does not. timestampMS
// is Unix milliseconds, matching the TS source's Date.now() unit
// exactly (NOT Unix seconds).
func SignOutboundWebhook(secret string, rawBody []byte, timestampMS int64) string {
	signedPayload := strconv.FormatInt(timestampMS, 10) + "." + string(rawBody)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signedPayload))
	digest := hex.EncodeToString(mac.Sum(nil))
	return fmt.Sprintf("t=%d,v1=%s", timestampMS, digest)
}

// InvalidWebhookSignatureError mirrors InvalidWebhookSignatureError.
type InvalidWebhookSignatureError struct {
	Detail string
}

func (e *InvalidWebhookSignatureError) Error() string {
	return fmt.Sprintf("Invalid outbound webhook signature: %s", e.Detail)
}

// VerifyOutboundWebhookSignature mirrors verifyOutboundWebhookSignature
// exactly — shipped mainly as a reference implementation of the
// verification a PRODUCT should perform on their end (docs/runbooks
// material), and so this package's own delivery tests can assert
// round-trip correctness. nowMS is Unix milliseconds; pass 0 to default
// to time.Now().
func VerifyOutboundWebhookSignature(secret string, rawBody []byte, signatureHeader string, nowMS int64) error {
	if nowMS == 0 {
		nowMS = time.Now().UnixMilli()
	}

	parts := map[string]string{}
	for _, part := range splitTopLevel(signatureHeader, ',') {
		kv := splitTopLevel(part, '=')
		if len(kv) != 2 {
			continue
		}
		parts[kv[0]] = kv[1]
	}

	timestampStr, hasTimestamp := parts["t"]
	providedSignature, hasSig := parts["v1"]
	if !hasTimestamp || !hasSig || timestampStr == "" || providedSignature == "" {
		return &InvalidWebhookSignatureError{Detail: "missing t= or v1= component"}
	}
	timestamp, err := strconv.ParseInt(timestampStr, 10, 64)
	if err != nil {
		return &InvalidWebhookSignatureError{Detail: "missing t= or v1= component"}
	}

	age := nowMS - timestamp
	if age < 0 {
		age = -age
	}
	if age > MaxSignatureAgeMS {
		return &InvalidWebhookSignatureError{Detail: "timestamp outside the allowed window (possible replay)"}
	}

	expected := SignOutboundWebhook(secret, rawBody, timestamp)
	expectedSignature := expected[len(expected)-64:] // v1= is followed by a 64-char hex sha256 digest.

	a := []byte(providedSignature)
	b := []byte(expectedSignature)
	if len(a) != len(b) || !hmac.Equal(a, b) {
		return &InvalidWebhookSignatureError{Detail: "signature mismatch"}
	}
	return nil
}

// splitTopLevel is a tiny helper avoiding a strings.Split import
// footprint mismatch with the TS source's simple .split(',') — behaves
// identically to strings.Split for our purposes (ASCII separators,
// no quoting), kept local for clarity.
func splitTopLevel(s string, sep byte) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == sep {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}

// OutboxEventEnvelope mirrors the shape internal/worker's outbox-relay
// dispatch hands to every `outbox.<event_type>` consumer task — the Go
// analogue of outboxRelay.ts's OutboxEventEnvelope.
type OutboxEventEnvelope struct {
	OutboxEventID string
	AggregateType string
	AggregateID   string
	EventType     string
	Payload       json.RawMessage
}

// outboundWebhookPayload mirrors OutboundWebhookPayload exactly — the
// shape internal/statemachine/db.go's insertOutboundWebhookOutboxRow
// produces.
type outboundWebhookPayload struct {
	Event            string          `json:"event"`
	ProductID        string          `json:"productId"`
	MerchantEntityID string          `json:"merchantEntityId"`
	PaymentID        string          `json:"paymentId"`
	OccurredAt       string          `json:"occurredAt"`
	Data             json.RawMessage `json:"data"`
}

// DeliveryResult mirrors OutboundWebhookDeliveryResult.
type DeliveryResult struct {
	Attempted int
	Delivered int
	Failed    int
}

const deliveryTimeout = 10 * time.Second

// httpDoer is the minimal capability DeliverOutboundWebhook needs from
// an HTTP client — satisfied structurally by *http.Client, and, in
// tests, by any hand-rolled fake with a matching Do method. Mirrors
// this port's standing narrow-interface-over-concrete-type preference
// (internal/ledger.Querier, internal/outbox.Execer, ...).
type httpDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

var defaultHTTPClient httpDoer = &http.Client{Timeout: deliveryTimeout}

type endpointRow struct {
	ID            string
	URL           string
	SigningSecret string
	EventTypes    []string
}

// DeliverOutboundWebhook mirrors createOutboundWebhookDeliveryTask's
// handler exactly:
//  1. Load every enabled outbound_webhook_endpoints row for the
//     event's product.
//  2. Skip endpoints not subscribed to this specific stable event name.
//  3. Skip an endpoint that already has a 'delivered' outbound_webhook_deliveries
//     row for this exact outbox event (idempotent per (endpoint,
//     outboxEvent) — a retry of this whole task must not re-deliver to
//     an endpoint that already got a successful response earlier).
//  4. POST the signed body; upsert the delivery row (ON CONFLICT
//     (endpoint_id, outbox_event_id) DO UPDATE, incrementing attempts)
//     regardless of success/failure.
func DeliverOutboundWebhook(ctx context.Context, pool *pgxpool.Pool, envelope OutboxEventEnvelope) (DeliveryResult, error) {
	return deliverOutboundWebhook(ctx, pool, defaultHTTPClient, envelope)
}

func deliverOutboundWebhook(ctx context.Context, pool *pgxpool.Pool, client httpDoer, envelope OutboxEventEnvelope) (DeliveryResult, error) {
	var payload outboundWebhookPayload
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
		return DeliveryResult{}, fmt.Errorf("outbound: unmarshal outbox payload for event %s: %w", envelope.OutboxEventID, err)
	}

	rows, err := pool.Query(ctx,
		`SELECT id, url, signing_secret, event_types FROM outbound_webhook_endpoints
		 WHERE product_id = $1 AND is_enabled = true`,
		payload.ProductID,
	)
	if err != nil {
		return DeliveryResult{}, fmt.Errorf("outbound: query endpoints for product %s: %w", payload.ProductID, err)
	}
	var endpoints []endpointRow
	for rows.Next() {
		var e endpointRow
		var eventTypesJSON []byte
		if err := rows.Scan(&e.ID, &e.URL, &e.SigningSecret, &eventTypesJSON); err != nil {
			rows.Close()
			return DeliveryResult{}, fmt.Errorf("outbound: scan endpoint row: %w", err)
		}
		_ = json.Unmarshal(eventTypesJSON, &e.EventTypes) // absent/malformed -> empty slice, matching `?? []` in the TS source.
		endpoints = append(endpoints, e)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return DeliveryResult{}, fmt.Errorf("outbound: iterate endpoint rows: %w", err)
	}
	rows.Close()

	var result DeliveryResult
	for _, endpoint := range endpoints {
		if !containsString(endpoint.EventTypes, payload.Event) {
			continue
		}

		var existingStatus *string
		err := pool.QueryRow(ctx,
			`SELECT status FROM outbound_webhook_deliveries WHERE endpoint_id = $1 AND outbox_event_id = $2`,
			endpoint.ID, envelope.OutboxEventID,
		).Scan(&existingStatus)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return result, fmt.Errorf("outbound: query existing delivery for endpoint %s event %s: %w", endpoint.ID, envelope.OutboxEventID, err)
		}
		if existingStatus != nil && *existingStatus == "delivered" {
			continue
		}

		result.Attempted++

		body, err := json.Marshal(map[string]any{
			"id":         envelope.OutboxEventID,
			"event":      payload.Event,
			"paymentId":  payload.PaymentID,
			"occurredAt": payload.OccurredAt,
			"data":       payload.Data,
		})
		if err != nil {
			return result, fmt.Errorf("outbound: marshal delivery body for endpoint %s: %w", endpoint.ID, err)
		}

		signature := SignOutboundWebhook(endpoint.SigningSecret, body, time.Now().UnixMilli())

		status := "failed"
		var responseStatus *int
		var lastError *string

		req, reqErr := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.URL, bytes.NewReader(body))
		if reqErr != nil {
			msg := reqErr.Error()
			lastError = &msg
			result.Failed++
		} else {
			req.Header.Set("content-type", "application/json")
			req.Header.Set("x-webhook-signature", signature)
			req.Header.Set("x-webhook-event-id", envelope.OutboxEventID)

			deliverCtx, cancel := context.WithTimeout(ctx, deliveryTimeout)
			req = req.WithContext(deliverCtx)
			resp, doErr := client.Do(req)
			cancel()
			if doErr != nil {
				msg := doErr.Error()
				lastError = &msg
				result.Failed++
			} else {
				code := resp.StatusCode
				responseStatus = &code
				_, _ = io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				if code >= 200 && code < 300 {
					status = "delivered"
					result.Delivered++
				} else {
					msg := fmt.Sprintf("non-2xx response: %d", code)
					lastError = &msg
					result.Failed++
				}
			}
		}

		if err := upsertDelivery(ctx, pool, deliveryUpsert{
			ID:            mustUUID(),
			EndpointID:    endpoint.ID,
			OutboxEventID: envelope.OutboxEventID,
			EventType:     payload.Event,
			Payload:       body,
			Status:        status,
			ResponseStatus: responseStatus,
			LastError:      lastError,
		}); err != nil {
			return result, err
		}
	}

	return result, nil
}

type deliveryUpsert struct {
	ID             string
	EndpointID     string
	OutboxEventID  string
	EventType      string
	Payload        []byte
	Status         string
	ResponseStatus *int
	LastError      *string
}

// upsertDelivery mirrors the TS handler's
// .insertInto('outbound_webhook_deliveries')...onConflict(...).doUpdateSet(...)
// call exactly: on conflict (endpoint_id, outbox_event_id), increments
// attempts (rather than resetting it to 1) and overwrites
// status/response_status/last_error/delivered_at with this attempt's
// outcome.
func upsertDelivery(ctx context.Context, pool *pgxpool.Pool, u deliveryUpsert) error {
	var deliveredAt any
	if u.Status == "delivered" {
		deliveredAt = time.Now()
	}
	_, err := pool.Exec(ctx,
		`INSERT INTO outbound_webhook_deliveries (
			id, endpoint_id, outbox_event_id, event_type, payload, status, attempts,
			response_status, last_error, delivered_at
		) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9)
		 ON CONFLICT (endpoint_id, outbox_event_id) DO UPDATE SET
			status = EXCLUDED.status,
			attempts = outbound_webhook_deliveries.attempts + 1,
			response_status = EXCLUDED.response_status,
			last_error = EXCLUDED.last_error,
			delivered_at = EXCLUDED.delivered_at,
			updated_at = now()`,
		u.ID, u.EndpointID, u.OutboxEventID, u.EventType, u.Payload, u.Status, u.ResponseStatus, u.LastError, deliveredAt,
	)
	if err != nil {
		return fmt.Errorf("outbound: upsert delivery for endpoint %s event %s: %w", u.EndpointID, u.OutboxEventID, err)
	}
	return nil
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func mustUUID() string {
	id, err := uuid.NewV7()
	if err != nil {
		// uuid.NewV7 only fails if the system's crypto/rand source is
		// broken — a condition this process cannot meaningfully recover
		// from anyway; every other id-generation call site in this port
		// (outbox.InsertEvent, webhooks.Ingest, etc.) propagates this
		// error instead of panicking, but doing so here would require
		// threading yet another error return through an already-deep
		// call chain for a practically-unreachable failure mode.
		panic(fmt.Errorf("outbound: generate delivery id: %w", err))
	}
	return id.String()
}
