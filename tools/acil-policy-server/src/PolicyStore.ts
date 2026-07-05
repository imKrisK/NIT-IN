/**
 * ACIL — PolicyStore
 *
 * In-memory policy registry for the Policy Server.
 * Production upgrade path: swap `_store` for a Redis/PostgreSQL adapter.
 *
 * Seed via ACIL_POLICY_SEED_JSON env var (JSON string of team→policy map)
 * or via POST /policy/:team at runtime.
 */

import { ACILWorkspaceConfig } from './types';

export class PolicyStore {
  private _store = new Map<string, ACILWorkspaceConfig>();

  constructor() {
    this._seedFromEnv();
  }

  get(teamId: string): ACILWorkspaceConfig | undefined {
    return this._store.get(teamId);
  }

  set(teamId: string, policy: ACILWorkspaceConfig): void {
    this._store.set(teamId, { ...policy });
  }

  listTeams(): string[] {
    return Array.from(this._store.keys());
  }

  private _seedFromEnv(): void {
    const raw = process.env.ACIL_POLICY_SEED_JSON;
    if (!raw) return;
    try {
      const map = JSON.parse(raw) as Record<string, ACILWorkspaceConfig>;
      for (const [team, policy] of Object.entries(map)) {
        this._store.set(team, policy);
      }
    } catch {
      console.warn('ACIL PolicyStore: Failed to parse ACIL_POLICY_SEED_JSON — ignoring seed');
    }
  }
}
