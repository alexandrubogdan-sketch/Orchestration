package domain

import "testing"

func TestIsHardDecline(t *testing.T) {
	if !IsHardDecline(RetryClassNever) {
		t.Error("IsHardDecline(never) = false, want true")
	}
	if IsHardDecline(RetryClassSameInstrumentLater) {
		t.Error("IsHardDecline(same_instrument_later) = true, want false")
	}
}

func TestIsEligibleForPspFailover(t *testing.T) {
	if !IsEligibleForPspFailover(RetryClassRetryDifferentPSP) {
		t.Error("IsEligibleForPspFailover(retry_different_psp) = false, want true")
	}
	for _, rc := range DeclineRetryClasses {
		if rc == RetryClassRetryDifferentPSP {
			continue
		}
		if IsEligibleForPspFailover(rc) {
			t.Errorf("IsEligibleForPspFailover(%q) = true, want false", rc)
		}
	}
}

func TestUnmappedDecline_FlagsForReview(t *testing.T) {
	decline := UnmappedDecline("stripe", "some_new_code_stripe_added")
	if decline.Category != DeclineCategoryUnmapped {
		t.Errorf("Category = %q, want unmapped", decline.Category)
	}
	if decline.RetryClass != RetryClassReview {
		t.Errorf("RetryClass = %q, want review", decline.RetryClass)
	}
	if decline.RawCode != "some_new_code_stripe_added" {
		t.Errorf("RawCode = %q, want some_new_code_stripe_added", decline.RawCode)
	}
}

func TestStripeDeclineSeed_IncludesRequiredMinimumCodes(t *testing.T) {
	requiredCodes := []string{
		"insufficient_funds",
		"do_not_honor",
		"generic_decline",
		"stolen_card",
		"lost_card",
		"pickup_card",
		"fraudulent",
		"invalid_account",
		"expired_card",
		"authentication_required",
		"processing_error",
		"issuer_not_available",
		"card_not_supported",
		"currency_not_supported",
	}
	seededCodes := make(map[string]struct{}, len(StripeDeclineSeed))
	for _, d := range StripeDeclineSeed {
		seededCodes[d.RawCode] = struct{}{}
	}
	for _, code := range requiredCodes {
		if _, ok := seededCodes[code]; !ok {
			t.Errorf("required code %q missing from StripeDeclineSeed", code)
		}
	}
}

func TestStripeDeclineSeed_EveryEntryUsesValidCategoryAndRetryClass(t *testing.T) {
	validCategories := make(map[DeclineCategory]struct{}, len(DeclineCategories))
	for _, c := range DeclineCategories {
		validCategories[c] = struct{}{}
	}
	validRetryClasses := make(map[DeclineRetryClass]struct{}, len(DeclineRetryClasses))
	for _, rc := range DeclineRetryClasses {
		validRetryClasses[rc] = struct{}{}
	}
	for _, d := range StripeDeclineSeed {
		if _, ok := validCategories[d.Category]; !ok {
			t.Errorf("entry %q has invalid category %q", d.RawCode, d.Category)
		}
		if _, ok := validRetryClasses[d.RetryClass]; !ok {
			t.Errorf("entry %q has invalid retryClass %q", d.RawCode, d.RetryClass)
		}
	}
}

func TestStripeDeclineSeed_DoNotRetrySetIsRetryClassNever(t *testing.T) {
	doNotRetryCodes := []string{"stolen_card", "lost_card", "pickup_card", "fraudulent"}
	byCode := make(map[string]stripeSeedEntry, len(StripeDeclineSeed))
	for _, d := range StripeDeclineSeed {
		byCode[d.RawCode] = d
	}
	for _, code := range doNotRetryCodes {
		entry, ok := byCode[code]
		if !ok {
			t.Fatalf("code %q not found in seed", code)
		}
		if entry.RetryClass != RetryClassNever {
			t.Errorf("entry %q RetryClass = %q, want never", code, entry.RetryClass)
		}
	}
}

func TestStripeDeclineSeed_AuthenticationRequiredIsRetryAfterChallenge(t *testing.T) {
	var found *stripeSeedEntry
	for i := range StripeDeclineSeed {
		if StripeDeclineSeed[i].RawCode == "authentication_required" {
			found = &StripeDeclineSeed[i]
			break
		}
	}
	if found == nil {
		t.Fatal("authentication_required not found in seed")
	}
	if found.RetryClass != RetryClassRetryAfterChallenge {
		t.Errorf("RetryClass = %q, want retry_after_challenge", found.RetryClass)
	}
	if found.Category != DeclineCategoryAuthentication {
		t.Errorf("Category = %q, want authentication", found.Category)
	}
}

func TestStripeDeclineSeed_HasExactlyExpectedEntryCount(t *testing.T) {
	// 1:1 port of every entry in src/domain/declines.ts's
	// STRIPE_DECLINE_SEED array — see MIGRATION_NOTES.md.
	const want = 49
	if len(StripeDeclineSeed) != want {
		t.Errorf("len(StripeDeclineSeed) = %d, want %d", len(StripeDeclineSeed), want)
	}
}
