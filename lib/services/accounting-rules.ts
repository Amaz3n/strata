import type { AccountingDimensionKind, AccountingDimensionValue, AccountingTarget } from "@/lib/integrations/accounting/provider"

export type AccountingMapCandidate = {
  id: string
  connection_id: string
  scope: AccountingTarget["resolvedFrom"]
  dimensions: Partial<Record<AccountingDimensionKind, AccountingDimensionValue>> | null
}

const PRECEDENCE: AccountingTarget["resolvedFrom"][] = ["project", "community", "division", "org_default"]

export function selectAccountingMap(rows: AccountingMapCandidate[]) {
  const winner = PRECEDENCE.map((scope) => rows.find((row) => row.scope === scope)).find(Boolean)
  if (!winner) return null
  const dimensions = PRECEDENCE.slice().reverse()
    .map((scope) => rows.find((row) => row.scope === scope && row.connection_id === winner.connection_id)?.dimensions ?? {})
    .reduce<Partial<Record<AccountingDimensionKind, AccountingDimensionValue>>>((merged, item) => ({ ...merged, ...item }), {})
  return { winner, dimensions }
}

export function accountingPushBlockReason(input: {
  hasTarget: boolean
  healthy: boolean
  pushable?: boolean | null
  existingConnectionId?: string | null
  targetConnectionId?: string | null
  enabled: boolean
}) {
  if (!input.hasTarget) return "unconnected" as const
  if (!input.healthy) return "connection_unhealthy" as const
  if (input.pushable === false) return "inbound_only" as const
  if (input.existingConnectionId && input.targetConnectionId && input.existingConnectionId !== input.targetConnectionId) return "connection_mismatch" as const
  if (!input.enabled) return "disabled" as const
  return null
}
