package api

import (
	"strings"
	"testing"
)

// This file ports test/unit/auth.test.ts's generateApiToken/hashApiToken
// cases. Both functions are pure aside from crypto/rand.Read, so no
// fakes/live DB are needed — the same "narrow enough to test without
// infrastructure" property the TS suite itself relies on.

func TestGenerateAPIToken_HasStablePrefix(t *testing.T) {
	raw, _, err := GenerateAPIToken()
	if err != nil {
		t.Fatalf("GenerateAPIToken returned error: %v", err)
	}
	if !strings.HasPrefix(raw, "po_") {
		t.Errorf("raw = %q, want prefix po_", raw)
	}
	if len(raw) <= 20 {
		t.Errorf("len(raw) = %d, want > 20", len(raw))
	}
}

func TestGenerateAPIToken_DifferentOnEveryCall(t *testing.T) {
	rawA, hashA, err := GenerateAPIToken()
	if err != nil {
		t.Fatalf("GenerateAPIToken returned error: %v", err)
	}
	rawB, hashB, err := GenerateAPIToken()
	if err != nil {
		t.Fatalf("GenerateAPIToken returned error: %v", err)
	}
	if rawA == rawB {
		t.Error("two calls to GenerateAPIToken produced the same raw token")
	}
	if hashA == hashB {
		t.Error("two calls to GenerateAPIToken produced the same hash")
	}
}

func TestHashAPIToken_DeterministicForSameInput(t *testing.T) {
	if HashAPIToken("po_abc123") != HashAPIToken("po_abc123") {
		t.Error("HashAPIToken is not deterministic for identical input")
	}
}

func TestHashAPIToken_NeverReturnsRawInput(t *testing.T) {
	raw := "po_super_secret_value"
	hash := HashAPIToken(raw)
	if hash == raw {
		t.Error("HashAPIToken returned the raw input unchanged")
	}
	if strings.Contains(hash, raw) {
		t.Error("HashAPIToken's output contains the raw input")
	}
}

func TestGenerateAPIToken_HashMatchesHashAPIToken(t *testing.T) {
	raw, hash, err := GenerateAPIToken()
	if err != nil {
		t.Fatalf("GenerateAPIToken returned error: %v", err)
	}
	if HashAPIToken(raw) != hash {
		t.Error("GenerateAPIToken's returned hash does not match HashAPIToken(raw)")
	}
}
