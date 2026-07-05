/**
 * Shared type definitions for the ACIL Policy Server.
 * Mirrors ACILWorkspaceConfig from @nit-in/acil without creating a hard dep.
 */

export interface ACILWorkspaceConfig {
  version:                  number;
  monthlyBudget?:           number;
  overageCostPerUnit?:      number;
  preferredModel?:          string;
  maxAgenticSessionsPerDay?: number;
  enableCCT?:               boolean;
  enableTSP?:               boolean;
  teamName?:                string;
  enforcementPolicy?:       'strict' | 'advisory' | 'silent';
}
