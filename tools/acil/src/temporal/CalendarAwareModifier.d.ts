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
    weekdayMultiplier: number;
    saturdayMultiplier: number;
    sundayMultiplier: number;
    sprintStartMultiplier: number;
}
export declare const DEFAULT_MODIFIERS: CalendarModifiers;
export declare class CalendarAwareModifier {
    private _modifiers;
    private _sprintStartDays;
    constructor(modifiers?: Partial<CalendarModifiers>, sprintStartDays?: string[]);
    /**
     * Returns the burn rate multiplier for a given date.
     * Sprint start days take precedence over day-of-week.
     */
    multiplierFor(date: Date): number;
    /**
     * Projects forward `days` days from `startDate`, returning a multiplier per day.
     */
    projectMultipliers(startDate: Date, days: number): Array<{
        date: Date;
        multiplier: number;
    }>;
    private _dateKey;
}
//# sourceMappingURL=CalendarAwareModifier.d.ts.map