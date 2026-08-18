/**
 * Division scope, decided once.
 *
 * Divisions are the enforcement layer under communities: a user scoped to a
 * division must not read — or write — anything outside it. Four call sites were
 * re-deriving the same three-way decision inline ("see nothing", "see only
 * these", "see everything"), and the write paths were quietly missing it, so a
 * division-scoped `community.write` holder could edit communities they could not
 * see.
 *
 * Pure — no data access — so the read gate and the write gate cannot drift.
 */

export interface DivisionScope {
  /** True when the caller's membership restricts them to explicit divisions. */
  assignedOnly: boolean
  divisionIds: string[]
}

export type DivisionScopeDecision =
  /** Nothing is visible. Callers return empty rather than querying. */
  | { kind: "none" }
  /** No filter applies. */
  | { kind: "all" }
  /** Filter `division_id` to exactly these. Never empty. */
  | { kind: "limited"; divisionIds: string[] }

/**
 * `requestedDivisionId` is the ambient desk lens. Asking for a division outside
 * the caller's scope resolves to "none" rather than silently widening to their
 * own divisions — a lens must never become an escalation.
 */
export function resolveDivisionScope(
  scope: DivisionScope,
  requestedDivisionId?: string | null,
): DivisionScopeDecision {
  if (!scope.assignedOnly) {
    return requestedDivisionId ? { kind: "limited", divisionIds: [requestedDivisionId] } : { kind: "all" }
  }
  if (scope.divisionIds.length === 0) return { kind: "none" }
  if (requestedDivisionId) {
    return scope.divisionIds.includes(requestedDivisionId)
      ? { kind: "limited", divisionIds: [requestedDivisionId] }
      : { kind: "none" }
  }
  return { kind: "limited", divisionIds: scope.divisionIds }
}

/** Whether one row's division passes the decision. The write gate's question. */
export function divisionIsInScope(decision: DivisionScopeDecision, divisionId: string | null): boolean {
  if (decision.kind === "all") return true
  if (decision.kind === "none") return false
  return divisionId != null && decision.divisionIds.includes(divisionId)
}
