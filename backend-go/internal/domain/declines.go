package domain

import "fmt"

// DeclineCategory classifies a normalized decline by broad cause.
type DeclineCategory string

const (
	DeclineCategoryHard           DeclineCategory = "hard"
	DeclineCategorySoft           DeclineCategory = "soft"
	DeclineCategoryFraud          DeclineCategory = "fraud"
	DeclineCategoryAuthentication DeclineCategory = "authentication"
	DeclineCategoryTechnical      DeclineCategory = "technical"
	DeclineCategoryUnmapped       DeclineCategory = "unmapped"
)

// DeclineCategories enumerates every valid DeclineCategory.
var DeclineCategories = []DeclineCategory{
	DeclineCategoryHard,
	DeclineCategorySoft,
	DeclineCategoryFraud,
	DeclineCategoryAuthentication,
	DeclineCategoryTechnical,
	DeclineCategoryUnmapped,
}

// DeclineRetryClass classifies whether/how a decline is safe to retry.
type DeclineRetryClass string

const (
	RetryClassNever               DeclineRetryClass = "never"
	RetryClassSameInstrumentLater DeclineRetryClass = "same_instrument_later"
	RetryClassRetryAfterChallenge DeclineRetryClass = "retry_after_challenge"
	RetryClassRetryDifferentPSP   DeclineRetryClass = "retry_different_psp"
	RetryClassReview              DeclineRetryClass = "review"
)

// DeclineRetryClasses enumerates every valid DeclineRetryClass.
var DeclineRetryClasses = []DeclineRetryClass{
	RetryClassNever,
	RetryClassSameInstrumentLater,
	RetryClassRetryAfterChallenge,
	RetryClassRetryDifferentPSP,
	RetryClassReview,
}

// NormalizedDecline is a PSP-agnostic decline classification. PSP
// adapters (a later phase) translate PSP-specific raw codes into this
// shape via a decline_code_map table; nothing outside the adapter layer
// should ever see a raw PSP code.
type NormalizedDecline struct {
	PSP            string
	RawCode        string
	NormalizedCode string
	Category       DeclineCategory
	RetryClass     DeclineRetryClass
	Description    *string
}

// IsHardDecline reports whether retryClass is "never" — hard declines
// and fraud declines are never retried on the same instrument, on any
// processor. This is the single central check every retry path must
// consult before scheduling another attempt.
func IsHardDecline(retryClass DeclineRetryClass) bool {
	return retryClass == RetryClassNever
}

// IsEligibleForPspFailover reports whether retryClass is
// "retry_different_psp". Only technical failures are allowed to
// cascade to a different PSP; soft/hard/fraud declines never cascade
// cross-PSP.
func IsEligibleForPspFailover(retryClass DeclineRetryClass) bool {
	return retryClass == RetryClassRetryDifferentPSP
}

func stringPtr(s string) *string { return &s }

// UnmappedDecline is the fallback classification for any raw code with
// no decline_code_map entry. Callers must also increment the
// unmapped_decline_code_total metric — this function only produces the
// classification, not the side effect.
func UnmappedDecline(psp string, rawCode string) NormalizedDecline {
	return NormalizedDecline{
		PSP:            psp,
		RawCode:        rawCode,
		NormalizedCode: "unmapped",
		Category:       DeclineCategoryUnmapped,
		RetryClass:     RetryClassReview,
		Description:    stringPtr(fmt.Sprintf("No decline_code_map entry for %s:%s — flagged for manual review", psp, rawCode)),
	}
}

// stripeSeedEntry is NormalizedDecline minus PSP — matches the TS
// Omit<NormalizedDecline, 'psp'> shape used for STRIPE_DECLINE_SEED.
type stripeSeedEntry struct {
	RawCode        string
	NormalizedCode string
	Category       DeclineCategory
	RetryClass     DeclineRetryClass
	Description    string
}

// StripeDeclineSeed is the Stripe decline-code seed data (the minimum
// required set per the original task, plus the ~27 additional codes
// audited against Stripe's own documented decline-code table in a
// later session of the TS project). rawCode matches Stripe's
// decline_code / code values as documented in the Stripe API
// reference. Loaded into decline_code_map by a seed script in a later
// phase. This is a straight 1:1 transcription of every entry in the TS
// STRIPE_DECLINE_SEED array — re-verify against
// payment-orchestrator/src/domain/declines.ts if this ever needs to
// change.
var StripeDeclineSeed = []stripeSeedEntry{
	{
		RawCode:        "insufficient_funds",
		NormalizedCode: "insufficient_funds",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassSameInstrumentLater,
		Description:    "The card has insufficient funds to complete the purchase.",
	},
	{
		RawCode:        "do_not_honor",
		NormalizedCode: "do_not_honor",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassSameInstrumentLater,
		Description:    "The issuer declined the charge without further detail.",
	},
	{
		RawCode:        "generic_decline",
		NormalizedCode: "generic_decline",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassSameInstrumentLater,
		Description:    "The card was declined for an unspecified reason.",
	},
	{
		RawCode:        "stolen_card",
		NormalizedCode: "stolen_card",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "The card is reported stolen.",
	},
	{
		RawCode:        "lost_card",
		NormalizedCode: "lost_card",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "The card is reported lost.",
	},
	{
		RawCode:        "pickup_card",
		NormalizedCode: "pickup_card",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "The card cannot be used and the issuer has requested it be retained.",
	},
	{
		RawCode:        "fraudulent",
		NormalizedCode: "fraudulent",
		Category:       DeclineCategoryFraud,
		RetryClass:     RetryClassNever,
		Description:    "The payment was flagged as fraudulent.",
	},
	{
		RawCode:        "invalid_account",
		NormalizedCode: "invalid_account",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "The card, or account the card is connected to, is invalid.",
	},
	{
		RawCode:        "expired_card",
		NormalizedCode: "expired_card",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "The card has expired.",
	},
	{
		RawCode:        "authentication_required",
		NormalizedCode: "authentication_required",
		Category:       DeclineCategoryAuthentication,
		RetryClass:     RetryClassRetryAfterChallenge,
		Description:    "The card was declined as it requires 3D Secure authentication.",
	},
	{
		RawCode:        "processing_error",
		NormalizedCode: "processing_error",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassSameInstrumentLater,
		Description:    "An error occurred processing the card, unrelated to the card itself.",
	},
	{
		RawCode:        "issuer_not_available",
		NormalizedCode: "issuer_not_available",
		Category:       DeclineCategoryTechnical,
		RetryClass:     RetryClassRetryDifferentPSP,
		Description:    "The card issuer could not be reached, so the payment could not be authorized.",
	},
	{
		RawCode:        "card_not_supported",
		NormalizedCode: "card_not_supported",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "The card does not support this type of purchase.",
	},
	{
		RawCode:        "currency_not_supported",
		NormalizedCode: "currency_not_supported",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "The card does not support the specified currency.",
	},
	{
		RawCode:        "call_issuer",
		NormalizedCode: "call_issuer",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "The card has been declined and the issuer asks that the customer call them.",
	},
	{
		RawCode:        "pin_try_exceeded",
		NormalizedCode: "pin_try_exceeded",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "The allowable number of PIN tries has been exceeded.",
	},
	{
		RawCode:        "restricted_card",
		NormalizedCode: "restricted_card",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "The card cannot be used for this type of purchase.",
	},
	{
		RawCode:        "try_again_later",
		NormalizedCode: "try_again_later",
		Category:       DeclineCategoryTechnical,
		RetryClass:     RetryClassRetryDifferentPSP,
		Description:    "The card was declined for an unspecified reason; ask the customer to try again.",
	},
	{
		RawCode:        "authentication_not_handled",
		NormalizedCode: "authentication_not_handled",
		Category:       DeclineCategoryAuthentication,
		RetryClass:     RetryClassRetryAfterChallenge,
		Description:    "A 3DS/SCA challenge was required but not completed before confirming.",
	},
	{
		RawCode:        "approve_with_id",
		NormalizedCode: "approve_with_id",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassSameInstrumentLater,
		Description:    "The payment could not be authorized on this attempt; the issuer suggests retrying.",
	},
	{
		RawCode:        "card_velocity_exceeded",
		NormalizedCode: "card_velocity_exceeded",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassSameInstrumentLater,
		Description:    "The customer has exceeded the balance, credit limit, or transaction amount limit on their card.",
	},
	{
		RawCode:        "duplicate_transaction",
		NormalizedCode: "duplicate_transaction",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassReview,
		Description:    "A transaction with identical amount and card was submitted very recently — flagged for manual review rather than auto-retried.",
	},
	{
		RawCode:        "incorrect_address",
		NormalizedCode: "incorrect_address",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassSameInstrumentLater,
		Description:    "The billing address entered by the customer is incorrect (AVS failure).",
	},
	{
		RawCode:        "incorrect_cvc",
		NormalizedCode: "incorrect_cvc",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassSameInstrumentLater,
		Description:    "The CVC number is incorrect.",
	},
	{
		RawCode:        "invalid_cvc",
		NormalizedCode: "incorrect_cvc",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassSameInstrumentLater,
		Description:    "The CVC number is incorrect (Stripe uses invalid_cvc and incorrect_cvc interchangeably per its own docs).",
	},
	{
		RawCode:        "incorrect_number",
		NormalizedCode: "incorrect_number",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassSameInstrumentLater,
		Description:    "The card number is incorrect.",
	},
	{
		RawCode:        "invalid_number",
		NormalizedCode: "incorrect_number",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassSameInstrumentLater,
		Description:    "The card number is incorrect (Stripe uses invalid_number and incorrect_number interchangeably per its own docs).",
	},
	{
		RawCode:        "incorrect_pin",
		NormalizedCode: "incorrect_pin",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassSameInstrumentLater,
		Description:    "The PIN entered is incorrect (card-present only).",
	},
	{
		RawCode:        "invalid_pin",
		NormalizedCode: "incorrect_pin",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassSameInstrumentLater,
		Description:    "The PIN entered is incorrect (Stripe uses invalid_pin and incorrect_pin interchangeably per its own docs).",
	},
	{
		RawCode:        "incorrect_zip",
		NormalizedCode: "incorrect_zip",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassSameInstrumentLater,
		Description:    "The postal code entered by the customer is incorrect (AVS failure).",
	},
	{
		RawCode:        "invalid_amount",
		NormalizedCode: "invalid_amount",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "The payment amount is invalid or exceeds the amount the issuer allows for this card.",
	},
	{
		RawCode:        "invalid_expiry_month",
		NormalizedCode: "invalid_expiry_date",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassSameInstrumentLater,
		Description:    "The expiration month entered is invalid.",
	},
	{
		RawCode:        "invalid_expiry_year",
		NormalizedCode: "invalid_expiry_date",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassSameInstrumentLater,
		Description:    "The expiration year entered is invalid.",
	},
	{
		RawCode:        "merchant_blacklist",
		NormalizedCode: "fraudulent",
		Category:       DeclineCategoryFraud,
		RetryClass:     RetryClassNever,
		Description:    "The payment matches a value on the merchant's own block list.",
	},
	{
		RawCode:        "new_account_information_available",
		NormalizedCode: "new_account_information_available",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "The card/account is invalid — the issuer indicates updated account info is available (account-updater territory).",
	},
	{
		RawCode:        "no_action_taken",
		NormalizedCode: "generic_decline",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassSameInstrumentLater,
		Description:    "The card was declined for an unspecified reason.",
	},
	{
		RawCode:        "not_permitted",
		NormalizedCode: "not_permitted",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "This payment is not permitted on this card/account.",
	},
	{
		RawCode:        "offline_pin_required",
		NormalizedCode: "pin_required",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "The card requires a PIN entered at a physical reader (card-present only — never applicable to this online orchestrator, kept for completeness).",
	},
	{
		RawCode:        "online_or_offline_pin_required",
		NormalizedCode: "pin_required",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "The card requires a PIN (card-present only — kept for completeness).",
	},
	{
		RawCode:        "reenter_transaction",
		NormalizedCode: "reenter_transaction",
		Category:       DeclineCategoryTechnical,
		RetryClass:     RetryClassRetryDifferentPSP,
		Description:    "The issuer couldn't process the payment for an unknown reason; safe to retry.",
	},
	{
		RawCode:        "revocation_of_all_authorizations",
		NormalizedCode: "revocation_of_authorization",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "The cardholder has revoked all standing authorizations on this card (relevant to MIT/subscription billing).",
	},
	{
		RawCode:        "revocation_of_authorization",
		NormalizedCode: "revocation_of_authorization",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "The cardholder has revoked authorization for this specific merchant/agreement.",
	},
	{
		RawCode:        "security_violation",
		NormalizedCode: "fraudulent",
		Category:       DeclineCategoryFraud,
		RetryClass:     RetryClassNever,
		Description:    "The issuer declined the payment for a suspected security violation.",
	},
	{
		RawCode:        "service_not_allowed",
		NormalizedCode: "not_permitted",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "This type of service/purchase is not allowed on this card.",
	},
	{
		RawCode:        "stop_payment_order",
		NormalizedCode: "stop_payment_order",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "The cardholder has placed a stop-payment order — never retry, including MIT renewals.",
	},
	{
		RawCode:        "testmode_decline",
		NormalizedCode: "testmode_decline",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "A Stripe test-mode card number was used against a live-mode request.",
	},
	{
		RawCode:        "transaction_not_allowed",
		NormalizedCode: "not_permitted",
		Category:       DeclineCategoryHard,
		RetryClass:     RetryClassNever,
		Description:    "The issuer does not allow this transaction on this card.",
	},
	{
		RawCode:        "withdrawal_count_limit_exceeded",
		NormalizedCode: "card_velocity_exceeded",
		Category:       DeclineCategorySoft,
		RetryClass:     RetryClassSameInstrumentLater,
		Description:    "The customer has exceeded the balance or credit limit available on their card.",
	},
	{
		RawCode:        "mobile_device_authentication_required",
		NormalizedCode: "authentication_required",
		Category:       DeclineCategoryAuthentication,
		RetryClass:     RetryClassRetryAfterChallenge,
		Description:    "The transaction requires the customer to re-authenticate via their mobile device (e.g. tap again).",
	},
}
