/**
 * ACIL — PolicyClient
 *
 * VS Code extension-side client for the ACIL Policy Server.
 * Fetches the team's .acil.json remotely, optionally verifying
 * the HMAC signature before applying.
 *
 * Configuration (VS Code settings):
 *   acil.policyServerUrl    — e.g. "https://acil.company.com"
 *   acil.policyTeamId       — e.g. "nexus-platform"
 *   acil.policyHmacKey      — shared secret for signature verification
 *   acil.policyPollIntervalMs — default 60 000 (1 min)
 *
 * Priority: remote policy (when fetched successfully) > local .acil.json > VS Code settings
 *
 * Author: imKrisK — Wave 11 Enterprise Feature
 */

import * as https from 'https';
import * as http  from 'http';
import * as crypto from 'crypto';
import { ACILWorkspaceConfig } from '../config/WorkspaceConfigLoader';

export interface SignedPolicy {
  policy:    ACILWorkspaceConfig;
  timestamp: string;
  signature: string;
  algorithm: 'sha256-hmac';
}

export interface PolicyFetchResult {
  config:   ACILWorkspaceConfig;
  verified: boolean;    // true if HMAC was checked and passed
  signed:   boolean;    // true if server returned a signed envelope
  fetchedAt: string;    // ISO-8601
}

export class PolicyClient {
  private _serverUrl:    string;
  private _teamId:       string;
  private _hmacKey:      string | undefined;
  private _pollInterval: number;
  private _timer:        ReturnType<typeof setInterval> | undefined;
  private _lastResult:   PolicyFetchResult | undefined;
  private _onChange?:    (cfg: ACILWorkspaceConfig, result: PolicyFetchResult) => void;

  constructor(opts: {
    serverUrl:       string;
    teamId:          string;
    hmacKey?:        string;
    pollIntervalMs?: number;
  }) {
    this._serverUrl    = opts.serverUrl.replace(/\/$/, '');
    this._teamId       = opts.teamId;
    this._hmacKey      = opts.hmacKey;
    this._pollInterval = opts.pollIntervalMs ?? 60_000;
  }

  /** Start polling the policy server. Fires onChange immediately on first fetch. */
  start(onChange: (cfg: ACILWorkspaceConfig, result: PolicyFetchResult) => void): void {
    this._onChange = onChange;
    void this._poll();
    this._timer = setInterval(() => void this._poll(), this._pollInterval);
  }

  /** Stop polling. Call on extension deactivate. */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  /** Last successfully fetched result. */
  get lastResult(): PolicyFetchResult | undefined { return this._lastResult; }

  private async _poll(): Promise<void> {
    try {
      const useSigned = !!this._hmacKey;
      const path      = useSigned
        ? `/policy/${this._teamId}/hmac`
        : `/policy/${this._teamId}`;

      const raw = await this._fetch(path);
      const body = JSON.parse(raw) as ACILWorkspaceConfig | SignedPolicy;

      let config:   ACILWorkspaceConfig;
      let verified  = false;
      let signed    = false;

      if ('signature' in body) {
        // Signed envelope path
        signed = true;
        if (this._hmacKey) {
          verified = this._verify(body as SignedPolicy, this._hmacKey);
          if (!verified) {
            console.warn('[ACIL PolicyClient] HMAC verification FAILED — ignoring remote policy');
            return;
          }
        }
        config = (body as SignedPolicy).policy;
      } else {
        config = body as ACILWorkspaceConfig;
      }

      const result: PolicyFetchResult = {
        config,
        verified,
        signed,
        fetchedAt: new Date().toISOString(),
      };
      this._lastResult = result;
      this._onChange?.(config, result);
    } catch (err) {
      // Network errors are non-fatal: fall back to local .acil.json
      console.warn(`[ACIL PolicyClient] Fetch failed — using local policy. ${err}`);
    }
  }

  private _fetch(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url      = `${this._serverUrl}${path}`;
      const protocol = url.startsWith('https') ? https : http;
      const req      = protocol.get(url, { timeout: 5000 }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    });
  }

  private _verify(envelope: SignedPolicy, key: string): boolean {
    const payload   = JSON.stringify(envelope.policy) + envelope.timestamp;
    const expected  = crypto.createHmac('sha256', key).update(payload, 'utf8').digest('hex');
    const expBuf    = Buffer.from(expected, 'hex');
    const actBuf    = Buffer.from(envelope.signature, 'hex');
    if (expBuf.length !== actBuf.length) return false;
    return crypto.timingSafeEqual(expBuf, actBuf);
  }
}
