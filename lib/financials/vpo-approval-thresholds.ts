export type VpoApprovalBand = {
  up_to_cents: number | null
  permission: string
}

export const DEFAULT_VPO_APPROVAL_BANDS: VpoApprovalBand[] = [
  { up_to_cents: 100_000, permission: "vpo.approve" },
  { up_to_cents: null, permission: "vpo.approve_large" },
]

export function parseVpoApprovalBands(value: unknown): VpoApprovalBand[] {
  if (!Array.isArray(value)) return DEFAULT_VPO_APPROVAL_BANDS
  const parsed = value.flatMap((item): VpoApprovalBand[] => {
    if (!item || typeof item !== "object") return []
    const row = item as Record<string, unknown>
    const permission = typeof row.permission === "string" ? row.permission : ""
    const limit = row.up_to_cents
    if (!permission || (limit !== null && (!Number.isInteger(limit) || Number(limit) < 0))) return []
    return [{ up_to_cents: limit === null ? null : Number(limit), permission }]
  })
  if (parsed.length === 0 || !parsed.some((band) => band.up_to_cents === null)) {
    return DEFAULT_VPO_APPROVAL_BANDS
  }
  return parsed.sort((a, b) => {
    if (a.up_to_cents === null) return 1
    if (b.up_to_cents === null) return -1
    return a.up_to_cents - b.up_to_cents
  })
}

export function requiredVpoApprovalPermission({
  totalCents,
  isBackcharge,
  bands,
}: {
  totalCents: number
  isBackcharge: boolean
  bands: VpoApprovalBand[]
}) {
  if (isBackcharge) return "vpo.approve_large"
  const absoluteTotal = Math.abs(totalCents)
  return bands.find((band) => band.up_to_cents === null || absoluteTotal <= band.up_to_cents)?.permission
    ?? "vpo.approve_large"
}

/**
 * Approval gates that are about *who* and *when* rather than how much.
 *
 * A band tells you which permission an amount needs; it cannot tell you that
 * the superintendent holding that permission is approving the variance he
 * raised himself, nor that the order in front of you was already rejected.
 * Returns the message to fail with, or null when approval may proceed.
 *
 * `isVariance` is true only when the change order carries a variance reason
 * code — subcontract change orders on residential and commercial jobs never
 * enter the variance discipline and keep their existing approval path.
 */
export function vpoApprovalBlockReason({
  status,
  isVariance,
  requestedBy,
  approverId,
}: {
  status: string
  isVariance: boolean
  requestedBy: string | null | undefined
  approverId: string
}): string | null {
  if (status === "voided") return "Voided commitment change orders cannot be approved."
  if (status === "rejected") {
    return "This change order was rejected and cannot be approved. Raise a new one instead."
  }
  if (isVariance && requestedBy && requestedBy === approverId) {
    return "A variance order must be approved by someone other than the person who requested it."
  }
  return null
}
