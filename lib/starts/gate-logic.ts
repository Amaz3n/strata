export type GateAppliesWhen = "always" | "financed_only" | "purchasing_enabled"
export type GateStatus = "pending" | "passed" | "waived" | "not_applicable"

export interface GateReadinessInput {
  key: string
  appliesWhen: GateAppliesWhen
  status: GateStatus
}
export const RELEASE_PRODUCED_GATE_KEYS = new Set(["budget", "po_set"])

/**
 * Typical calendar days a gate needs once someone starts chasing it. The permit
 * is the long pole in most jurisdictions, which is why it outranks everything
 * else when we name the one thing holding a house back.
 *
 * Gate definitions are org-configurable, so an unknown key falls back to a week.
 */
export const GATE_LEAD_DAYS: Record<string, number> = {
  permit: 35,
  financing: 21,
  selections_locked: 21,
  plot_plan: 10,
  price_book: 5,
  plan_pinned: 3,
  budget: 1,
  po_set: 1,
  final_approval: 1,
}
export const DEFAULT_GATE_LEAD_DAYS = 7

export function gateLeadDays(key: string) {
  return GATE_LEAD_DAYS[key] ?? DEFAULT_GATE_LEAD_DAYS
}

export function isGateApplicable(
  gate: Pick<GateReadinessInput, "appliesWhen">,
  flags: { isFinanced: boolean; purchasingEnabled: boolean },
) {
  if (gate.appliesWhen === "financed_only") return flags.isFinanced
  if (gate.appliesWhen === "purchasing_enabled") return flags.purchasingEnabled
  return true
}

export function isGateSatisfied(status: GateStatus) {
  return status === "passed" || status === "waived" || status === "not_applicable"
}

export function startPackageReadiness(
  gates: GateReadinessInput[],
  flags: { isFinanced: boolean; purchasingEnabled: boolean },
) {
  const applicable = gates.filter((gate) => isGateApplicable(gate, flags))
  const readinessGates = applicable.filter((gate) => !RELEASE_PRODUCED_GATE_KEYS.has(gate.key))
  const passed = readinessGates.filter((gate) => isGateSatisfied(gate.status)).length
  return {
    ready: readinessGates.length > 0 && passed === readinessGates.length,
    passed,
    total: readinessGates.length,
  }
}

export interface GateBlockerInput extends GateReadinessInput {
  label: string
  checkKind: "auto" | "manual"
}

export interface GateBlocker {
  key: string
  label: string
  checkKind: "auto" | "manual"
  leadDays: number
}

/**
 * The single gate a house is actually waiting on. Ranked by lead time rather
 * than by sort order, because "4 of 9 gates" is not something anyone can act
 * on — the permit that takes five weeks is, and it decides whether a target
 * week is still winnable at all.
 *
 * Gates the release itself produces (budget, PO set) are never blockers.
 */
export function pickBlocker(
  gates: GateBlockerInput[],
  flags: { isFinanced: boolean; purchasingEnabled: boolean },
): GateBlocker | null {
  const outstanding = gates
    .filter((gate) => isGateApplicable(gate, flags))
    .filter((gate) => !RELEASE_PRODUCED_GATE_KEYS.has(gate.key))
    .filter((gate) => !isGateSatisfied(gate.status))
  if (!outstanding.length) return null
  // Final approval is the attestation you give once everything else is clear,
  // so it only surfaces as the blocker when it is genuinely the last thing left.
  const substantive = outstanding.filter((gate) => gate.key !== "final_approval")
  const pool = substantive.length ? substantive : outstanding
  const blocker = pool.reduce((worst, gate) =>
    gateLeadDays(gate.key) > gateLeadDays(worst.key) ? gate : worst,
  )
  return {
    key: blocker.key,
    label: blocker.label,
    checkKind: blocker.checkKind,
    leadDays: gateLeadDays(blocker.key),
  }
}

export function canAttestFinalApproval(
  gates: GateReadinessInput[],
  flags: { isFinanced: boolean; purchasingEnabled: boolean },
) {
  return gates
    .filter((gate) => gate.key !== "final_approval")
    .filter((gate) => !RELEASE_PRODUCED_GATE_KEYS.has(gate.key))
    .filter((gate) => isGateApplicable(gate, flags))
    .every((gate) => isGateSatisfied(gate.status))
}
