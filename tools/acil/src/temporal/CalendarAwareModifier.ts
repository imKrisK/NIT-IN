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

export interface CalendarModifiers {
  weekdayMultiplier:   number;   // Default 1.0
  saturdayMultiplier:  number;   // Default 0.15 (nearly zero)
  sundayMultiplier:    number;   // Default 0.10
  sprintStartMultiplier: number; // Default 2.5 — first Mon of sprint
}

export const DEFAULT_MODIFIERS: CalendarModifiers = {
  weekdayMultiplier:    1.0,
  saturdayMultiplier:   0.15,
  sundayMultiplier:     0.10,
  sprintStartMultiplier: 2.5,
};

export class CalendarAwareModifier {
  private _modifiers: CalendarModifiers;
  private _sprintStartDays: Set<string>;   // YYYY-MM-DD of known sprint starts

  constructor(
    modifiers: Partial<CalendarModifiers> = {},
    sprintStartDays: string[] = [],
  ) {
    this._modifiers      = { ...DEFAULT_MODIFIERS, ...modifiers };
    this._sprintStartDays = new Set(sprintStartDays);
  }

  /**
   * Returns the burn rate multiplier for a given date.
   * Sprint start days take precedence over day-of-week.
   */
  multiplierFor(date: Date): number {
    const key = this._dateKey(date);
    if (this._sprintStartDays.has(key)) return this._modifiers.sprintStartMultiplier;

    const dow = date.getDay(); // 0=Sun, 6=Sat
    if (dow === 0) return this._modifiers.sundayMultiplier;
    if (dow === 6) return this._modifiers.saturdayMultiplier;
    return this._modifiers.weekdayMultiplier;
  }

  /**
   * Projects forward `days` days from `startDate`, returning a multiplier per day.
   */
  projectMultipliers(startDate: Date, days: number): Array<{ date: Date; multiplier: number }> {
    const result: Array<{ date: Date; multiplier: number }> = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      result.push({ date: d, multiplier: this.multiplierFor(d) });
    }
    return result;
  }

  private _dateKey(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
}
