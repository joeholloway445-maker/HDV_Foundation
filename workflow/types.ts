/** Shared type definitions for the HDV workflow integration layer. */

export interface WorkflowValidationResult {
  allowed: boolean;
  violations: string[];
  knollAuditId: string;
  timestamp: string;
}

export interface RouteDecision {
  model: string;
  category: string;
  budgetTier: string;
  routedByApex: boolean;
  reasoning: string;
}
