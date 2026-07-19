export type GateAppliesWhen = "always" | "financed_only" | "purchasing_enabled"
export type GateStatus = "pending" | "passed" | "waived" | "not_applicable"

export interface GateReadinessInput {
  key: string
  appliesWhen: GateAppliesWhen
  status: GateStatus
}
export const RELEASE_PRODUCED_GATE_KEYS = new Set(["budget", "po_set"])

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
