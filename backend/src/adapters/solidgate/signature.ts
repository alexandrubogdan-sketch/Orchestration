import { createHmac } from 'node:crypto';

export function computeSolidgateSignature(
  publicKey: string,
  secretKey: string,
  jsonString: string | null,
): string {
  const data =
    jsonString === null ? `${publicKey}${publicKey}` : `${publicKey}${jsonString}${publicKey}`;
  const hexDigest = createHmac('sha512', secretKey).update(data).digest('hex');
  return Buffer.from(hexDigest, 'utf8').toString('base64');
}

export interface SolidgateAuthHeaders {
  merchant: string;
  signature: string;
}

export function buildSolidgateAuthHeaders(
  publicKey: string,
  secretKey: string,
  jsonString: string | null,
): SolidgateAuthHeaders {
  return {
    merchant: publicKey,
    signature: computeSolidgateSignature(publicKey, secretKey, jsonString),
  };
}
