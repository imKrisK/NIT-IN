/**
 * ACIL VS Code Extension — TelemetryCollector
 *
 * Hooks into VS Code's workspace and editor APIs to produce
 * TelemetrySignals for the SessionClassifier.
 *
 * Monitors:
 *   - Text document changes (file modification velocity)
 *   - Active editor changes (file switching patterns)
 *   - Git status (new vs modified files)
 *   - Chat input interception (when available via Copilot API)
 *
 * This is the IDE telemetry layer referenced in Wave 10 Claim 1 + 2:
 * "continuously analyzes IDE telemetry signals...comprising at least
 *  file change patterns, tool invocation signatures, and natural
 *  language query patterns"
 *
 * PRIVACY NOTE: All telemetry stays local. No data leaves the machine
 * except through the developer's own AI API calls. ACIL does not phone home.
 */

import * as vscode from 'vscode';
import { TelemetrySignals } from '@nit-in/acil';

interface FileChangeRecord {
  uri:       string;
  isNew:     boolean;
  timestamp: number;
}

export class TelemetryCollector implements vscode.Disposable {
  private _disposables: vscode.Disposable[] = [];
  private _fileChanges:  FileChangeRecord[] = [];
  private _sessionStart: number = Date.now();
  private _newFileUris:  Set<string> = new Set();
  private _knownFileUris: Set<string> = new Set();

  constructor() {
    // Track document opens (signals new files or broad context loading)
    this._disposables.push(
      vscode.workspace.onDidOpenTextDocument(doc => {
        if (doc.uri.scheme !== 'file') return;
        const isNew = !this._knownFileUris.has(doc.uri.toString());
        if (isNew) this._newFileUris.add(doc.uri.toString());
        this._knownFileUris.add(doc.uri.toString());
        this._fileChanges.push({
          uri:       doc.uri.toString(),
          isNew,
          timestamp: Date.now(),
        });
      })
    );

    // Track document saves (signals active modification)
    this._disposables.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.uri.scheme !== 'file') return;
        this._fileChanges.push({
          uri:       doc.uri.toString(),
          isNew:     false,
          timestamp: Date.now(),
        });
      })
    );

    // Seed known files from currently open editors
    vscode.workspace.textDocuments.forEach(doc => {
      if (doc.uri.scheme === 'file') {
        this._knownFileUris.add(doc.uri.toString());
      }
    });
  }

  /**
   * Produce TelemetrySignals from current session state.
   * Called by the pipeline before each AI request.
   *
   * @param queryText   The developer's current chat/prompt input
   * @param toolCalls   Tool call signatures detected (from Copilot agent context)
   */
  collect(queryText: string, toolCalls: string[] = []): TelemetrySignals {
    const windowMs   = 5 * 60 * 1000; // 5-minute sliding window
    const now        = Date.now();
    const recentChanges = this._fileChanges.filter(c => now - c.timestamp < windowMs);

    // New files created in this session
    const newFileCount = this._newFileUris.size;

    // Modified files in recent window (distinct URIs)
    const modifiedUris = new Set(recentChanges.filter(c => !c.isNew).map(c => c.uri));
    const modifiedFileCount = modifiedUris.size;

    // Context ratio: how many of the open files are freshly opened vs long-standing
    const totalOpen    = vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'file').length;
    const recentOpens  = recentChanges.filter(c => c.isNew).length;
    const contextRatio = totalOpen > 0
      ? Math.min(1.0, 1 - (recentOpens / Math.max(totalOpen, 1)))
      : 0.5;

    // Error context: look for error patterns in active editor content
    const hasErrorContext = this._detectErrorContext(queryText);

    // File similarity proxy: if modifying many files similar to existing structure
    const existingFileSimilarity = this._estimateFileSimilarity(recentChanges);

    return {
      queryText,
      toolCallSignatures:     toolCalls,
      newFileCount,
      modifiedFileCount,
      contextRatio,
      hasErrorContext,
      existingFileSimilarity,
    };
  }

  /**
   * Reset session tracking (call when starting a new coding session).
   */
  resetSession(): void {
    this._fileChanges  = [];
    this._newFileUris  = new Set();
    this._sessionStart = Date.now();
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
  }

  private _detectErrorContext(query: string): boolean {
    const errorPatterns = [
      /TypeError/i, /ReferenceError/i, /SyntaxError/i,
      /Cannot read prop/i, /is not a function/i,
      /undefined is not/i, /null is not/i,
      /\bat\s+\w+.*:\d+:\d+/,          // stack trace line
      /Error:/i, /exception/i, /crash/i,
      /failed to compile/i, /build failed/i,
    ];
    return errorPatterns.some(p => p.test(query));
  }

  private _estimateFileSimilarity(recentChanges: FileChangeRecord[]): number {
    if (recentChanges.length === 0) return 0.3;
    // If most recent changes are to existing files (not new), likely boilerplate
    const existingRatio = recentChanges.filter(c => !c.isNew).length / recentChanges.length;
    return Math.min(1.0, existingRatio);
  }
}
