"use strict";
/**
 * ACIL — CalendarAwareModifier
 *
 * Applies day-of-week and sprint-cycle multipliers to daily burn rate projections.
 * Part of the Temporal Spend Predictor (TSP).
 *
 * NOVEL: calendar-aware LLM burn rate forecasting has no prior art.
 * Empirical basis: inventor's June 2026 data shows zero usage on weekends
 * (Jun 6 Sat = 0 requests; Jun 13-14 = 0 requests) vs. heavy weekday burn.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CalendarAwareModifier = exports.DEFAULT_MODIFIERS = void 0;
exports.DEFAULT_MODIFIERS = {
    weekdayMultiplier: 1.0,
    saturdayMultiplier: 0.15,
    sundayMultiplier: 0.10,
    sprintStartMultiplier: 2.5,
};
class CalendarAwareModifier {
    _modifiers;
    _sprintStartDays; // YYYY-MM-DD of known sprint starts
    constructor(modifiers = {}, sprintStartDays = []) {
        this._modifiers = { ...exports.DEFAULT_MODIFIERS, ...modifiers };
        this._sprintStartDays = new Set(sprintStartDays);
    }
    /**
     * Returns the burn rate multiplier for a given date.
     * Sprint start days take precedence over day-of-week.
     */
    multiplierFor(date) {
        const key = this._dateKey(date);
        if (this._sprintStartDays.has(key))
            return this._modifiers.sprintStartMultiplier;
        const dow = date.getDay(); // 0=Sun, 6=Sat
        if (dow === 0)
            return this._modifiers.sundayMultiplier;
        if (dow === 6)
            return this._modifiers.saturdayMultiplier;
        return this._modifiers.weekdayMultiplier;
    }
    /**
     * Projects forward `days` days from `startDate`, returning a multiplier per day.
     */
    projectMultipliers(startDate, days) {
        const result = [];
        for (let i = 0; i < days; i++) {
            const d = new Date(startDate);
            d.setDate(d.getDate() + i);
            result.push({ date: d, multiplier: this.multiplierFor(d) });
        }
        return result;
    }
    _dateKey(d) {
        return d.toISOString().slice(0, 10);
    }
}
exports.CalendarAwareModifier = CalendarAwareModifier;
