package solidgate

import (
	"crypto/hmac"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
)

// ComputeSignature implements Solidgate's request-signing scheme, as
// documented at
// docs.solidgate.com/payments/integrate/access-to-api/#generate-signature
// (confirmed against their published docs in the TS reference
// implementation, not guessed):
//
//  1. Concatenate publicKey + jsonString + publicKey (or just
//     publicKey + publicKey for a GET request with no body).
//  2. Compute HMAC-SHA512 of that string, keyed with the Secret key.
//  3. Take the HEX representation of that HMAC digest (as a string of
//     lowercase hex characters, produced by encoding/hex).
//  4. Base64-encode the HEX STRING ITSELF (not the raw digest bytes) —
//     this double-encoding is unusual but is exactly what Solidgate's
//     docs and reference snippets describe.
//
// *** THE GOTCHA, SPELLED OUT EXPLICITLY *** — this is the single
// easiest place to invert this function by accident: step 4 base64-
// encodes the ASCII BYTES OF THE HEX STRING (e.g. the 128-character
// string "a3f9..."), NOT the 64 raw bytes the HMAC digest itself
// consists of. Concretely:
//
//	digest := hmac.New(sha512.New, secretKey).Sum(data)      // 64 raw bytes
//	hexString := hex.EncodeToString(digest)                  // 128-char ASCII string
//	signature := base64.StdEncoding.EncodeToString([]byte(hexString)) // <-- CORRECT: base64 of the 128 ASCII bytes of hexString
//	wrong := base64.StdEncoding.EncodeToString(digest)       // <-- WRONG: this is Stripe/most-PSPs'-style single-encoding, NOT what Solidgate expects
//
// A single-encoding implementation (base64 of the raw 64-byte digest,
// skipping the hex step, or hex-decoding hexString back to bytes before
// base64-encoding) produces a DIFFERENT, shorter string that will fail
// signature verification against Solidgate's API/webhooks silently
// (wrong signature -> 401/webhook rejected, not a crash) — there is no
// type error to catch this, only a live API/webhook call, which is
// exactly why this function's construction is spelled out this
// explicitly instead of just "hex then base64."
//
// The same function verifies inbound webhooks too, per Solidgate's own
// docs ("Solidgate uses a similar authentication method for webhooks,
// with merchant and signature parameters included in the headers") —
// just with the Webhook key pair (wh_pk_/wh_sk_) instead of the API key
// pair (api_pk_/api_sk_).
func ComputeSignature(publicKey string, secretKey string, jsonString *string) string {
	var data string
	if jsonString == nil {
		data = publicKey + publicKey
	} else {
		data = publicKey + *jsonString + publicKey
	}

	mac := hmac.New(sha512.New, []byte(secretKey))
	mac.Write([]byte(data))
	digest := mac.Sum(nil) // 64 raw bytes (SHA-512 output size)

	hexDigest := hex.EncodeToString(digest) // 128-char lowercase hex ASCII string

	// Base64-encode the HEX STRING'S BYTES (its ASCII representation),
	// NOT the raw digest — see the gotcha explanation above. []byte(hexDigest)
	// is the UTF-8 (== ASCII, since hex digits are all ASCII) byte
	// representation of the hex string itself.
	return base64.StdEncoding.EncodeToString([]byte(hexDigest))
}

// AuthHeaders is the pair of headers every Solidgate request/webhook
// verification carries.
type AuthHeaders struct {
	Merchant  string
	Signature string
}

// BuildAuthHeaders builds the merchant/signature header pair for an
// outbound Solidgate API request.
func BuildAuthHeaders(publicKey string, secretKey string, jsonString *string) AuthHeaders {
	return AuthHeaders{
		Merchant:  publicKey,
		Signature: ComputeSignature(publicKey, secretKey, jsonString),
	}
}
