"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeveloperPatternIdentifier = exports.LearnAdapter = exports.ACILLearn = void 0;
var ACILLearn_1 = require("./ACILLearn");
Object.defineProperty(exports, "ACILLearn", { enumerable: true, get: function () { return ACILLearn_1.ACILLearn; } });
var LearnAdapter_1 = require("./LearnAdapter");
Object.defineProperty(exports, "LearnAdapter", { enumerable: true, get: function () { return LearnAdapter_1.LearnAdapter; } });
var acil_1 = require("@nit-in/acil");
Object.defineProperty(exports, "DeveloperPatternIdentifier", { enumerable: true, get: function () { return acil_1.DeveloperPatternIdentifier; } });
