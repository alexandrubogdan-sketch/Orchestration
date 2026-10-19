import type { AppConfig } from '../../config/index.js';
import type { PspAccountMode } from '../../db/types.js';

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

  void pspAccount.secretRef;

  return {
    mode: config.stripe.mode,
    secretKey: config.stripe.secretKey,
    publishableKey: config.stripe.publishableKey,
    webhookSecret: config.stripe.webhookSecret,
  };
}
