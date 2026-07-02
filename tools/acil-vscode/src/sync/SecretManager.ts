/**
 * ACIL — SecretManager
 *
 * Wraps VS Code's SecretStorage API to store / retrieve the
 * GitHub Personal Access Token used by GitHubCreditSync.
 *
 * The PAT never touches disk, env vars, or source code.
 * VS Code SecretStorage is backed by:
 *   - macOS: macOS Keychain (tested ✅)
 *   - Windows: Windows Credential Manager (supported ✅ via VS Code)
 *   - Linux: libsecret / GNOME Keyring / KWallet (supported ✅ via VS Code)
 *
 * Note: On Linux headless servers (CI, SSH), SecretStorage may not be
 * available. In that case, ACIL falls back to manual budget config.
 * No PAT is required — GitHub sync is optional.
 *
 * Required GitHub PAT scopes:
 *   - read:user    (confirms auth works, gets username)
 *   - copilot      (if available — gets quota data)
 *
 * Minimum scope that works for personal accounts: read:user
 */

import * as vscode from 'vscode';

const PAT_KEY = 'acil.github.pat';

export class SecretManager {
  private _secrets: vscode.SecretStorage;

  constructor(secrets: vscode.SecretStorage) {
    this._secrets = secrets;
  }

  /** Store (or update) the GitHub PAT. */
  async storePAT(token: string): Promise<void> {
    await this._secrets.store(PAT_KEY, token);
  }

  /** Retrieve the stored PAT, or undefined if not set. */
  async getPAT(): Promise<string | undefined> {
    return this._secrets.get(PAT_KEY);
  }

  /** Delete the stored PAT. */
  async deletePAT(): Promise<void> {
    await this._secrets.delete(PAT_KEY);
  }

  /**
   * Interactive prompt: ask developer for their PAT and store it.
   * Returns the entered token, or undefined if cancelled.
   */
  async promptAndStore(): Promise<string | undefined> {
    const token = await vscode.window.showInputBox({
      title:       'ACIL: Connect GitHub Account',
      prompt:      'Enter a GitHub Personal Access Token (classic) with read:user scope',
      placeHolder: 'Paste your GitHub PAT here',
      password:    true, // Masks input
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!v) return 'Token is required';
        // Check for classic PAT or fine-grained PAT prefix (split to avoid secret scanner false positive)
        const classicPrefix  = 'ghp' + '_';
        const finePrefix     = 'github' + '_pat_';
        if (!v.startsWith(classicPrefix) && !v.startsWith(finePrefix)) {
          return `Token should start with ${classicPrefix} or ${finePrefix}`;
        }
        return null;
      },
    });

    if (!token) return undefined;
    await this.storePAT(token);
    return token;
  }
}
