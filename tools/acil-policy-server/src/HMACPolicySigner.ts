/**
 * ACIL — HMACPolicySigner
 *
 * Signs an ACILWorkspaceConfig with HMAC-SHA256 for tamper-proof delivery.
 * Client verifies the signature before applying the policy.
 *
 * Signed envelope format:
 * {
 *   policy:    ACILWorkspaceConfig,
 *   timestamp: ISO-8601 string (included in the signature to prevent replay),
 *   signature: hex string,
 *   algorithm: "sha256-hmac"
 * }
 */

import * as crypto from 'crypto';
import { ACILWorkspaceConfig } from './types';

export interface SignedPolicy {
  policy:    ACILWorkspaceConfig;
  timestamp: string;
  signature: string;
  algorithm: 'sha256-hmac';
}

/** Sign policy JSON + timestamp with HMAC-SHA256. */
export function signPolicy(policy: ACILWorkspaceConfig, key: string): SignedPolicy {
  const timestamp = new Date().toISOString();
  const payload   = JSON.stringify(policy) + timestamp;
  const signature = crypto
    .createHmac('sha256', key)
    .update(payload, 'utf8')
    .digest('hex');

  return { policy, timestamp, signature, algorithm: 'sha256-hmac' };
}

/** Verify a signed policy. Returns true only if signature matches. */
export function verifyPolicy(envelope: SignedPolicy, key: string): boolean {
  const payload   = JSON.stringify(envelope.policy) + envelope.timestamp;
  const expected  = crypto
    .createHmac('sha256', key)
    .update(payload, 'utf8')
    .digest('hex');

  // Constant-time comparison — prevents timing attacks
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf   = Buffer.from(envelope.signature, 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
