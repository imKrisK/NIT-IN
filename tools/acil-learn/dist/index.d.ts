/**
 * @nit-in/acil-learn
 *
 * Meta-Recursive Learning SDK for third-party embedding.
 *
 * Provides a clean, framework-agnostic API for adding self-calibrating
 * LLM cost governance to any Node.js application, IDE plugin, or
 * AI coding assistant — without depending on VS Code APIs.
 *
 * ══════════════════════════════════════════════════════════
 * PATENT: Wave 11 — Meta-Recursive ACIL Calibration
 * Author: imKrisK (github.com/imKrisK)
 * ══════════════════════════════════════════════════════════
 *
 * Quickstart:
 *
 *   import { ACILLearn } from '@nit-in/acil-learn';
 *
 *   const learn = new ACILLearn({ storagePath: './.acil-learn' });
 *   await learn.load();
 *
 *   // Before sending to LLM:
 *   const prediction = await learn.predict({ sessionType: 'DEBUGGING', tokenEstimate: 1800 });
 *   console.log(prediction.adaptedCCTThreshold); // e.g. 0.30 for DEBUGGING
 *
 *   // After LLM response:
 *   await learn.record({
 *     predictionId:  prediction.predictionId,
 *     actualCost:    0.0042,
 *     actualTokens:  1923,
 *     cctApplied:    true,
 *     semanticScore: 0.81,
 *   });
 *
 *   await learn.save();
 */
export { ACILLearn } from './ACILLearn';
export { LearnAdapter } from './LearnAdapter';
export type { LearnConfig, PredictInput, PredictOutput, RecordInput } from './ACILLearn';
export type { RecursivePrediction, LoopOutcome } from '@nit-in/acil';
export { DeveloperPatternIdentifier } from '@nit-in/acil';
export type { ArchetypeProfile } from '@nit-in/acil';
//# sourceMappingURL=index.d.ts.map