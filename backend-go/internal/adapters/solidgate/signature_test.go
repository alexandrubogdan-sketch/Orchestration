package solidgate

import (
	"crypto/hmac"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"testing"
)

// TestComputeSignature_DoubleEncodingGotcha is the single
// highest-value test in this package: it pins down the exact
// "base64-of-hex-STRING, not base64-of-raw-bytes" behavior the
// project's own docs flag as the easiest place to invert this
// function. It recomputes the expected value from first principles
// (independently of ComputeSignature's own implementation) so a
// regression that silently switches to single-encoding would be
// caught here, not just by eyeballing the source again.
func TestComputeSignature_DoubleEncodingGotcha(t *testing.T) {
	publicKey := "api_pk_test123"
	secretKey := "api_sk_test456"
	jsonString := `{"order_id":"pay_1"}`

	got := ComputeSignature(publicKey, secretKey, &jsonString)

	// Independently recomputed expected value: hex digest string, then
	// base64 of that string's ASCII bytes.
	data := publicKey + jsonString + publicKey
	mac := hmac.New(sha512.New, []byte(secretKey))
	mac.Write([]byte(data))
	digest := mac.Sum(nil)
	hexDigest := hex.EncodeToString(digest)
	want := base64.StdEncoding.EncodeToString([]byte(hexDigest))

	if got != want {
		t.Fatalf("ComputeSignature = %q, want %q (double-encoding mismatch)", got, want)
	}

	// Explicitly assert this does NOT equal the single-encoding
	// (base64 of raw digest bytes) result — this is the exact wrong
	// answer the docs warn about, and pinning down that they differ is
	// as important as pinning down the right answer.
	wrongSingleEncoding := base64.StdEncoding.EncodeToString(digest)
	if got == wrongSingleEncoding {
		t.Fatal("ComputeSignature matched the single-encoding (wrong) result — the double-encoding step is not being applied")
	}

	// Sanity: hex.EncodeToString always produces an even-length,
	// lowercase-hex string (128 chars for SHA-512's 64-byte digest), so
	// the base64 input here is always longer than base64-of-raw-bytes
	// would be — cross-check the decoded length.
	decoded, err := base64.StdEncoding.DecodeString(got)
	if err != nil {
		t.Fatalf("ComputeSignature output is not valid base64: %v", err)
	}
	if len(decoded) != 128 {
		t.Errorf("decoded signature length = %d, want 128 (the hex string's character length, not 64 the raw digest's byte length)", len(decoded))
	}
	if string(decoded) != hexDigest {
		t.Errorf("decoded signature = %q, want the hex digest string %q", string(decoded), hexDigest)
	}
}

// TestComputeSignature_GetRequestNoBody covers the GET-request variant
// (jsonString == nil), which concatenates publicKey+publicKey per the
// documented scheme.
func TestComputeSignature_GetRequestNoBody(t *testing.T) {
	publicKey := "api_pk_test123"
	secretKey := "api_sk_test456"

	got := ComputeSignature(publicKey, secretKey, nil)

	data := publicKey + publicKey
	mac := hmac.New(sha512.New, []byte(secretKey))
	mac.Write([]byte(data))
	hexDigest := hex.EncodeToString(mac.Sum(nil))
	want := base64.StdEncoding.EncodeToString([]byte(hexDigest))

	if got != want {
		t.Fatalf("ComputeSignature(nil body) = %q, want %q", got, want)
	}
}

// TestComputeSignature_Deterministic verifies the same inputs always
// produce the same signature (no hidden randomness/timestamp
// dependency) — a basic sanity property for a signing function.
func TestComputeSignature_Deterministic(t *testing.T) {
	body := `{"a":1}`
	sig1 := ComputeSignature("pk", "sk", &body)
	sig2 := ComputeSignature("pk", "sk", &body)
	if sig1 != sig2 {
		t.Fatalf("ComputeSignature is non-deterministic: %q vs %q", sig1, sig2)
	}
}

// TestComputeSignature_DifferentBodyDifferentSignature is a basic
// sensitivity check.
func TestComputeSignature_DifferentBodyDifferentSignature(t *testing.T) {
	bodyA := `{"a":1}`
	bodyB := `{"a":2}`
	sigA := ComputeSignature("pk", "sk", &bodyA)
	sigB := ComputeSignature("pk", "sk", &bodyB)
	if sigA == sigB {
		t.Fatal("different bodies produced the same signature")
	}
}

// TestBuildAuthHeaders_MerchantIsPublicKey verifies the merchant header
// is simply the public key, unmodified.
func TestBuildAuthHeaders_MerchantIsPublicKey(t *testing.T) {
	headers := BuildAuthHeaders("api_pk_abc", "api_sk_def", nil)
	if headers.Merchant != "api_pk_abc" {
		t.Errorf("Merchant = %q, want api_pk_abc", headers.Merchant)
	}
	if headers.Signature == "" {
		t.Error("Signature is empty")
	}
}
