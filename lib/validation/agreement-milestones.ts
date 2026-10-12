import { z } from "zod"

import { MILESTONE_KINDS } from "@/lib/sales/agreement-milestones"

const uuid = z.string().uuid()
const reason = z.string().trim().min(10, "Give a reason of at least 10 characters").max(2000)

/** A milestone or contingency the coordinator adds to an executed agreement. */
export const addAgreementMilestoneSchema = z.object({
  projectId: uuid,
  kind: z.enum(MILESTONE_KINDS),
  title: z.string().trim().min(1).max(200),
  isContingency: z.boolean().default(false),
  requiredBefore: z.enum(["start", "closing"]).nullable(),
  dueOn: z.string().date().nullable(),
  ownerUserId: uuid.nullable().default(null),
  ownerCompanyId: uuid.nullable().default(null),
  evidenceRequired: z.boolean().default(false),
  dependsOn: z.array(uuid).max(20).default([]),
}).strict()

/** Owner, due date and (for a coordinator's own rows) the gate it holds. */
export const updateAgreementMilestoneSchema = z.object({
  milestoneId: uuid,
  version: z.number().int().positive(),
  ownerUserId: uuid.nullable().optional(),
  ownerCompanyId: uuid.nullable().optional(),
  dueOn: z.string().date().nullable().optional(),
  requiredBefore: z.enum(["start", "closing"]).nullable().optional(),
  reason: z.string().trim().max(2000).optional(),
}).strict()

export const resolveAgreementMilestoneSchema = z.discriminatedUnion("resolution", [
  z.object({ resolution: z.literal("satisfied"), milestoneId: uuid, version: z.number().int().positive(), resolvedOn: z.string().date(), evidenceFileId: uuid.nullable(), note: z.string().trim().max(2000).optional() }).strict(),
  z.object({ resolution: z.literal("waived"), milestoneId: uuid, version: z.number().int().positive(), resolvedOn: z.string().date(), note: reason }).strict(),
  z.object({ resolution: z.literal("failed"), milestoneId: uuid, version: z.number().int().positive(), resolvedOn: z.string().date(), note: reason }).strict(),
  z.object({ resolution: z.literal("open"), milestoneId: uuid, version: z.number().int().positive(), note: reason }).strict(),
])

export const createMilestoneSourceSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict()

/**
 * What a lender or title company posts. The agreement number, the buyer's email
 * and the lot are the reconciliation keys; the milestone is named by its kind.
 */
export const milestoneReportSchema = z.object({
  agreement_number: z.string().trim().min(1).max(100),
  buyer_email: z.string().trim().email().max(320),
  lot_number: z.string().trim().min(1).max(50),
  community: z.string().trim().min(1).max(200).optional(),
  milestone: z.enum(MILESTONE_KINDS),
  status: z.enum(["in_progress", "satisfied", "failed"]),
  reported_on: z.string().date(),
  reference: z.string().trim().max(200).optional(),
  note: z.string().trim().max(2000).optional(),
}).strict()

export type MilestoneReport = z.infer<typeof milestoneReportSchema>
