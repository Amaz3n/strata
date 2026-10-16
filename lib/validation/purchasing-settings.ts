import { z } from "zod"

/** The only keys an approval band may name: free text would let an admin point a band at any permission. */
export const VPO_BAND_PERMISSIONS = ["vpo.approve", "vpo.approve_large"] as const

export const MAX_APPROVAL_BANDS = 6
export const MAX_VARIANCE_REASON_CODES = 60

export const vpoApprovalBandSchema = z.object({
  up_to_cents: z.number().int().min(0).max(1_000_000_000_000).nullable(),
  permission: z.enum(VPO_BAND_PERMISSIONS),
})

/** Ascending limits, exactly one open-ended band and it is last. */
export function vpoBandsError(bands: Array<{ up_to_cents: number | null }>): string | null {
  const open = bands.findIndex((band) => band.up_to_cents === null)
  if (open !== bands.length - 1) return "The last approval band must have no upper limit, and only the last."
  for (let index = 1; index < bands.length - 1; index += 1) {
    const previous = bands[index - 1].up_to_cents
    const current = bands[index].up_to_cents
    if (previous !== null && current !== null && current <= previous) return "Approval band limits must increase."
  }
  return null
}

export const purchasingSettingsUpdateSchema = z.object({
  pay_on_po_enabled: z.boolean().optional(),
  po_completion_requires_verification: z.boolean().optional(),
  po_completion_requires_inspection: z.boolean().optional(),
  vpo_reason_code_required: z.boolean().optional(),
  /** Null: evidence is never required (a back-charge always needs it). 0: always required. */
  vpo_evidence_required_over_cents: z.number().int().min(0).max(1_000_000_000_000).nullable().optional(),
  expiring_agreement_lead_days: z.number().int().min(1).max(365).optional(),
  vpo_approval_thresholds: z.array(vpoApprovalBandSchema).min(1).max(MAX_APPROVAL_BANDS).optional(),
}).superRefine((value, context) => {
  if (!value.vpo_approval_thresholds) return
  const message = vpoBandsError(value.vpo_approval_thresholds)
  if (message) context.addIssue({ code: "custom", path: ["vpo_approval_thresholds"], message })
})

export const varianceReasonCodeSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, "Use lowercase letters, numbers and underscores"),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  is_backcharge: z.boolean().default(false),
})

export type PurchasingSettingsUpdate = z.infer<typeof purchasingSettingsUpdateSchema>
export type VarianceReasonCodeInput = z.input<typeof varianceReasonCodeSchema>
