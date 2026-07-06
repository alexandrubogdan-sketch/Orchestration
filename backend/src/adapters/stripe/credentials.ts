import type { AppConfig } from '../../config/index.js';
import type { PspAccountMode } from '../../db/types.js';

/**
 * Resolved, ready-to-use Stripe credentials for one psp_account row.
 * Never logged (see src/observability/logger.ts's redaction list, which
 * catches `client_secret` and anything keyed `card`/`number`/etc. at any
 * depth — secret/publishable keys are additionally never included in
 * any object passed to the logger in this file).
 */
export interface StripeCredentials {
  mode: PspAccountMode;
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
}

export class CredentialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialResolutionError';
  }
}

/**
 * Resolves a psp_account row's `secret_ref`/`publishable_key_ref`/
 * `webhook_secret_ref` (ADR-0005) into real credentials.
 *
 * THIS IS A DEV-ONLY STAND-IN. Production secret resolution — reading
 * from AWS Secrets Manager/Vault/Doppler by the `*_ref` value — is an
 * infra integration explicitly deferred by ADR-0003 ("infra decision
 * outside this repo's control"). Wiring a real backend here means
 * implementing this same function signature against that backend; every
 * caller in this codebase already goes through this function, not
 * `process.env` directly, so the swap is contained to this one file.
 *
 * The dev fallback below only works for the *one* set of credentials
 * the process's own `.env` provides (`config.stripe`), and only if the
 * requested `psp_account.mode` matches `config.stripe.mode` — this
 * catches the common local-dev mistake of a psp_account row marked
 * `production` while the process only has sandbox credentials loaded.
 */
export function resolveStripeCredentials(
  config: Pick<AppConfig, 'stripe'>,
  pspAccount: { mode: PspAccountMode; secretRef: string },
): StripeCredentials {
  if (pspAccount.mode !== config.stripe.mode) {
    throw new CredentialResolutionError(
      `psp_account requires mode="${pspAccount.mode}" credentials, but this process only has ` +
        `"${config.stripe.mode}" credentials loaded (config.stripe.mode). Dev-env credential ` +
        `resolution only supports a single mode per process — see src/adapters/stripe/credentials.ts.`,
    );
  }

  // In dev/CI, every psp_account's secret_ref resolves to the same
  // process-wide env credentials, regardless of the ref's actual value —
  // there's only one Stripe account configured locally. A real
  // secrets-manager-backed implementation would use `pspAccount.secretRef`
  // (an ARN/name) to fetch a DIFFERENT secret per account.
  void pspAccount.secretRef;

  return {
    mode: config.stripe.mode,
    secretKey: config.stripe.secretKey,
    publishableKey: config.stripe.publishableKey,
    webhookSecret: config.stripe.webhookSecret,
  };
}
