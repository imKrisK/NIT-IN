/**
 * ACIL — WorkspaceConfig
 *
 * Per-workspace `.acil.json` configuration file.
 * Loaded from workspace root on activate() — overrides VS Code settings.json
 * for team-wide enforcement. Checked into source control for team sharing.
 *
 * Priority order (highest → lowest):
 *   1. .acil.json in workspace root         ← team policy
 *   2. VS Code settings (acil.*)            ← individual preference
 *   3. ACIL hardcoded defaults              ← fallback
 *
 * Use case: team lead sets monthlyBudget + preferredModel in .acil.json.
 * All developers on the project inherit the same budget ceiling.
 * Individual developers can still set stricter limits via settings.json.
 *
 * Example .acil.json:
 * {
 *   "version": 1,
 *   "monthlyBudget": 39.00,
 *   "overageCostPerUnit": 0.04,
 *   "preferredModel": "copilot-premium",
 *   "maxAgenticSessionsPerDay": 10,
 *   "enableCCT": true,
 *   "enableTSP": true,
 *   "teamName": "nexus-platform",
 *   "enforcementPolicy": "strict"
 * }
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface ACILWorkspaceConfig {
  version:                  number;
  monthlyBudget?:           number;
  overageCostPerUnit?:      number;
  preferredModel?:          string;
  maxAgenticSessionsPerDay?: number;
  enableCCT?:               boolean;
  enableTSP?:               boolean;
  teamName?:                string;
  /**
   * 'strict'  — blocks AGENTIC sessions at CRITICAL, no override
   * 'advisory' — warns but never blocks (default for solo devs)
   * 'silent'  — no notifications, status bar only
   */
  enforcementPolicy?:       'strict' | 'advisory' | 'silent';
}

const CONFIG_FILENAME = '.acil.json';

export class WorkspaceConfigLoader {
  private _config: ACILWorkspaceConfig | null = null;
  private _watcher: vscode.FileSystemWatcher | undefined;
  private _onChange?: () => void;

  /**
   * Load .acil.json from the workspace root (if present).
   * Returns null if no workspace config file exists.
   */
  load(): ACILWorkspaceConfig | null {
    const filePath = this._findConfigFile();
    if (!filePath) {
      this._config = null;
      return null;
    }

    try {
      const raw  = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw) as ACILWorkspaceConfig;
      if (!data.version) throw new Error('Missing version field');
      this._config = data;
      return data;
    } catch (err) {
      vscode.window.showWarningMessage(
        `ACIL: Failed to parse .acil.json — ${err instanceof Error ? err.message : String(err)}. Using VS Code settings.`
      );
      this._config = null;
      return null;
    }
  }

  /** Get a specific value, falling back to VS Code settings, then default. */
  get<T>(key: keyof ACILWorkspaceConfig, vscodeSetting: string, defaultVal: T): T {
    // Workspace config takes precedence
    if (this._config && this._config[key] !== undefined) {
      return this._config[key] as unknown as T;
    }
    // VS Code settings next
    const config = vscode.workspace.getConfiguration('acil');
    const val    = config.get<T>(vscodeSetting);
    if (val !== undefined) return val;
    return defaultVal;
  }

  /** True if a .acil.json was found and loaded. */
  get hasWorkspaceConfig(): boolean { return this._config !== null; }

  /** The team name from the workspace config (or undefined). */
  get teamName(): string | undefined { return this._config?.teamName; }

  /** The enforcement policy (strict/advisory/silent). */
  get enforcementPolicy(): 'strict' | 'advisory' | 'silent' {
    return this._config?.enforcementPolicy ?? 'advisory';
  }

  /** Monthly budget in USD — from workspace config, VS Code settings, or default $39. */
  get monthlyBudget(): number {
    return this.get<number>('monthlyBudget', 'monthlyBudget', 39);
  }

  /**
   * Watch for .acil.json changes and reload automatically.
   * Call onChange callback when config changes.
   */
  watchWorkspace(onChange: () => void): vscode.Disposable {
    this._onChange = onChange;
    const pattern = new vscode.RelativePattern(
      vscode.workspace.workspaceFolders?.[0] ?? '',
      CONFIG_FILENAME,
    );
    this._watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this._watcher.onDidChange(() => { this.load(); this._onChange?.(); });
    this._watcher.onDidCreate(() => { this.load(); this._onChange?.(); });
    this._watcher.onDidDelete(() => { this._config = null; this._onChange?.(); });
    return this._watcher;
  }

  dispose(): void {
    this._watcher?.dispose();
  }

  /**
   * Apply a remotely fetched policy (from PolicyClient).
   * Remote policy takes precedence over local .acil.json.
   * Does NOT write to disk — lives only in memory.
   */
  applyRemote(remote: ACILWorkspaceConfig): void {
    // Merge: remote fields override local, but local non-overridden fields survive
    this._config = { ...this._config, ...remote };
  }

  private _findConfigFile(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    const candidate = path.join(folders[0].uri.fsPath, CONFIG_FILENAME);
    return fs.existsSync(candidate) ? candidate : null;
  }
}
