import { z } from "zod"

import { ENTITLEMENT_KINDS, ENTITLEMENT_MILESTONES, ENTITLEMENT_STATUSES } from "@/lib/land/entitlement-readiness"

const isoDate = z.string().date().optional().nullable()
const optionalId = z.string().uuid().optional().nullable()
const milestone = z.enum(ENTITLEMENT_MILESTONES).optional().nullable()

const entitlementFieldsSchema = z.object({
  communityPhaseId: optionalId,
  kind: z.enum(ENTITLEMENT_KINDS),
  name: z.string().trim().min(1, "Name the approval").max(200),
  jurisdiction: z.string().trim().max(200).optional().nullable(),
  agencyCompanyId: optionalId,
  referenceNumber: z.string().trim().max(120).optional().nullable(),
  status: z.enum(ENTITLEMENT_STATUSES).default("not_started"),
  requiredBefore: milestone,
  submittedOn: isoDate,
  targetOn: isoDate,
  approvedOn: isoDate,
  expiresOn: isoDate,
  ownerUserId: optionalId,
  notes: z.string().trim().max(4000).optional().nullable(),
})

export const entitlementInputSchema = entitlementFieldsSchema.superRefine((value, context) => {
  if (value.status === "approved" && !value.approvedOn) {
    context.addIssue({ code: "custom", path: ["approvedOn"], message: "An approved entitlement needs its approval date" })
  }
})
export type EntitlementInput = z.input<typeof entitlementInputSchema>

export const entitlementUpdateSchema = entitlementFieldsSchema.partial()
export type EntitlementUpdate = z.input<typeof entitlementUpdateSchema>

export const conditionInputSchema = z.object({
  title: z.string().trim().min(1, "Describe the condition").max(300),
  description: z.string().trim().max(4000).optional().nullable(),
  communityPhaseId: optionalId,
  requiredBefore: milestone,
  dueOn: isoDate,
  ownerUserId: optionalId,
  ownerCompanyId: optionalId,
})
export type ConditionInput = z.input<typeof conditionInputSchema>

export const conditionMeetSchema = z.object({ metOn: z.string().date() })
export const conditionWaiveSchema = z.object({
  reason: z.string().trim().min(10, "Say why the condition is waived (at least 10 characters)").max(2000),
})
