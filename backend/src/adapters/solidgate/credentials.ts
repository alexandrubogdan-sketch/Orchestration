import type { AppConfig } from '../../config/index.js';
import type { PspAccountMode } from '../../db/types.js';

/**
 * Mirrors src/adapters/stripe/credentials.ts's dev-only stand-in
 * pattern exactly — see that file's docblock for the full rationale
 * (production secret resolution is ADR-0003's deferred infra
 * decision; every caller goes through this one function, not
 * `process.env` directly).
 */
export interface SolidgateCredentials {
  mode: PspAccountMode;
  publicKey: string;
  secretKey: string;
  apiBaseUrl: string;
}

export class SolidgateCredentialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SolidgateCredentialResolutionError';
  }
}

export function resolveSolidgateCredentials(
  config: Pick<AppConfig, 'solidgate'>,
  pspAccount: { mode: PspAccountMode; secretRef: string },
): SolidgateCredentials {
  if (pspAccount.mode !== config.solidgate.mode) {
    throw new SolidgateCredentialResolutionError(
      `psp_account requires mode="${pspAccount.mode}" credentials, but this process only has ` +
        `"${config.solidgate.mode}" credentials loaded (config.solidgate.mode).`,
    );
  }
  if (!config.solidgate.publicKey || !config.solidgate.secretKey) {
    throw new SolidgateCredentialResolutionError(
      'SOLIDGATE_PUBLIC_KEY/SOLIDGATE_SECRET_KEY are not set on this process — a psp_account row ' +
        'requires them to resolve a Solidgate adapter. Solidgate credentials are optional at boot ' +
        "(unlike Stripe's) specifically so a deployment with no Solidgate accounts never needs them; " +
        'this error means one now does.',
    );
  }

  void pspAccount.secretRef; // dev stand-in: same process-wide credentials regardless of the ref value — see stripe/credentials.ts

  return {
    mode: config.solidgate.mode,
    publicKey: config.solidgate.publicKey,
    secretKey: config.solidgate.secretKey,
    apiBaseUrl: config.solidgate.apiBaseUrl,
  };
}

export interface SolidgateWebhookCredentials {
  webhookPublicKey: string;
  webhookSecretKey: string;
}

export function resolveSolidgateWebhookCredentials(
  config: Pick<AppConfig, 'solidgate'>,
): SolidgateWebhookCredentials {
  if (!config.solidgate.webhookPublicKey || !config.solidgate.webhookSecretKey) {
    throw new SolidgateCredentialResolutionError(
      'SOLIDGATE_WEBHOOK_PUBLIC_KEY/SOLIDGATE_WEBHOOK_SECRET_KEY are not set on this process.',
    );
  }
  return {
    webhookPublicKey: config.solidgate.webhookPublicKey,
    webhookSecretKey: config.solidgate.webhookSecretKey,
  };
}
