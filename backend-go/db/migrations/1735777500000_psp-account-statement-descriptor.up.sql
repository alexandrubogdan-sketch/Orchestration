-- 2026-07-08: per-integration custom statement descriptors.
--
-- Context: a merchant can connect several psp_accounts against the
-- same PSP (Stripe) — e.g. one per business line/brand (see
-- ADR-0005's mode-per-account model, extended by
-- 1735776200000_psp-account-modes's publishable_key_ref/
-- webhook_secret_ref columns for exactly this multi-instance case).
-- Each of those accounts can now carry its own dynamic statement
-- descriptor suffix, so two integrations against the same Stripe
-- account type show up differently on a cardholder's bank/card
-- statement (Stripe's documented "static prefix + dynamic suffix"
-- pattern for card charges: docs.stripe.com/get-started/account/
-- statement-descriptors). The prefix itself remains whatever is
-- configured in the connected Stripe account's own Dashboard — this
-- column only carries the per-charge dynamic suffix, which is the
-- part this API can actually set on each PaymentIntent.
--
-- Nullable: existing/most accounts have no override and fall back to
-- the PSP account's own default descriptor. The length check mirrors
-- Stripe's documented limit (prefix + " * " + suffix <= 22 chars;
-- since the prefix length varies, 22 is a safe upper bound we can
-- enforce before ever calling Stripe, so a too-long value fails fast
-- with a clear error instead of a PSP-side rejection).
ALTER TABLE psp_accounts
  ADD COLUMN statement_descriptor_suffix text
    CHECK (statement_descriptor_suffix IS NULL OR char_length(statement_descriptor_suffix) <= 22);
