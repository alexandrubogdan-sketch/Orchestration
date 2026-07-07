package routing

import "testing"

func strPtr(s string) *string { return &s }

func baseInput() Input {
	return Input{
		ProductID:         "product-1",
		Currency:          "USD",
		CitMit:            "cit",
		PaymentMethodType: "card",
	}
}

func testRule(overrides func(*Rule)) Rule {
	r := Rule{
		ID:                   "rule-default",
		MerchantEntityID:     "entity-1",
		ProductID:            nil,
		Priority:             100,
		IsEnabled:            true,
		Match:                MatchCriteria{},
		PspAccountID:         "psp-default",
		FallbackPspAccountID: nil,
		Description:          nil,
	}
	if overrides != nil {
		overrides(&r)
	}
	return r
}

func TestMatchesCriteria(t *testing.T) {
	input := baseInput()

	t.Run("an empty match object matches anything (wildcard rule)", func(t *testing.T) {
		if !MatchesCriteria(MatchCriteria{}, input) {
			t.Fatal("expected empty criteria to match")
		}
	})

	t.Run("matches when the currency allow-list includes the input currency", func(t *testing.T) {
		if !MatchesCriteria(MatchCriteria{Currency: []string{"USD", "EUR"}}, input) {
			t.Fatal("expected match")
		}
	})

	t.Run("rejects when the currency allow-list excludes the input currency", func(t *testing.T) {
		if MatchesCriteria(MatchCriteria{Currency: []string{"EUR"}}, input) {
			t.Fatal("expected no match")
		}
	})

	t.Run("rejects when citMit does not match", func(t *testing.T) {
		if MatchesCriteria(MatchCriteria{CitMit: []string{"mit"}}, input) {
			t.Fatal("expected no match")
		}
	})

	t.Run("rejects when paymentMethodType does not match", func(t *testing.T) {
		if MatchesCriteria(MatchCriteria{PaymentMethodType: []string{"wallet"}}, input) {
			t.Fatal("expected no match")
		}
	})

	t.Run("requires every specified dimension to match (AND, not OR)", func(t *testing.T) {
		criteria := MatchCriteria{Currency: []string{"USD"}, CitMit: []string{"mit"}}
		if MatchesCriteria(criteria, input) {
			t.Fatal("expected no match: currency matches but citMit doesn't")
		}
	})
}

func TestSortRules(t *testing.T) {
	t.Run("orders by priority ascending (lower number evaluated first)", func(t *testing.T) {
		rules := []Rule{
			testRule(func(r *Rule) { r.ID = "low-priority"; r.Priority = 50 }),
			testRule(func(r *Rule) { r.ID = "high-priority"; r.Priority = 10 }),
		}
		sorted := SortRules(rules)
		if sorted[0].ID != "high-priority" || sorted[1].ID != "low-priority" {
			t.Fatalf("unexpected order: %v", ruleIDs(sorted))
		}
	})

	t.Run("a product-specific rule wins a priority tie against an entity-wide rule", func(t *testing.T) {
		rules := []Rule{
			testRule(func(r *Rule) { r.ID = "entity-wide"; r.Priority = 10; r.ProductID = nil }),
			testRule(func(r *Rule) { r.ID = "product-specific"; r.Priority = 10; r.ProductID = strPtr("product-1") }),
		}
		sorted := SortRules(rules)
		if sorted[0].ID != "product-specific" || sorted[1].ID != "entity-wide" {
			t.Fatalf("unexpected order: %v", ruleIDs(sorted))
		}
	})

	t.Run("is stable with respect to the priority field for already-ordered input", func(t *testing.T) {
		rules := []Rule{
			testRule(func(r *Rule) { r.ID = "first"; r.Priority = 1 }),
			testRule(func(r *Rule) { r.ID = "second"; r.Priority = 2 }),
			testRule(func(r *Rule) { r.ID = "third"; r.Priority = 3 }),
		}
		sorted := SortRules(rules)
		want := []string{"first", "second", "third"}
		got := ruleIDs(sorted)
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("unexpected order: got %v, want %v", got, want)
			}
		}
	})

	t.Run("does not mutate the input array", func(t *testing.T) {
		rules := []Rule{
			testRule(func(r *Rule) { r.ID = "b"; r.Priority = 2 }),
			testRule(func(r *Rule) { r.ID = "a"; r.Priority = 1 }),
		}
		original := ruleIDs(rules)
		SortRules(rules)
		got := ruleIDs(rules)
		for i := range original {
			if got[i] != original[i] {
				t.Fatalf("input array was mutated: got %v, want %v", got, original)
			}
		}
	})
}

func ruleIDs(rules []Rule) []string {
	ids := make([]string, len(rules))
	for i, r := range rules {
		ids[i] = r.ID
	}
	return ids
}

func TestNoRoutablePspAccountError(t *testing.T) {
	err := &NoRoutablePspAccountError{ProductID: "product-42"}
	want := "No routable psp_account found for product product-42"
	if err.Error() != want {
		t.Fatalf("got %q, want %q", err.Error(), want)
	}
}
