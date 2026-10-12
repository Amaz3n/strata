import { z } from "zod"

import { PERMIT_FEE_DUE, PERMIT_FEE_KINDS } from "@/lib/permits/fees"
import { PERMIT_DECISIONS, PERMIT_TYPES } from "@/lib/permits/lifecycle"

const isoDate = z.string().date()
const documentKind = z.string().trim().regex(/^[a-z][a-z0-9_]{1,40}$/, "Use lowercase letters, digits and underscores")
const requiredFor = z.enum(["submission", "decision"])

export const createPermitApplicationSchema = z.object({
  projectId: z.string().uuid(),
  jurisdictionCompanyId: z.string().uuid("Choose the permitting authority"),
  permitType: z.enum(PERMIT_TYPES),
  ownerUserId: z.string().uuid().nullable().optional(),
  supersedesId: z.string().uuid().nullable().optional(),
})

export const assignPermitApplicationSchema = z.object({
  applicationId: z.string().uuid(),
  ownerUserId: z.string().uuid().nullable(),
})

export const setPermitDocumentSchema = z.object({
  applicationId: z.string().uuid(),
  documentKind,
  label: z.string().trim().max(160).nullable().optional(),
  requiredFor: requiredFor.nullable().optional(),
  fileId: z.string().uuid().nullable(),
})

export const recordPermitSubmissionSchema = z.object({
  applicationId: z.string().uuid(),
  submittedOn: isoDate,
  reference: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  respondsToRoundId: z.string().uuid().nullable().optional(),
})

export const recordCorrectionRoundSchema = z.object({
  applicationId: z.string().uuid(),
  receivedOn: isoDate,
  comments: z.string().trim().min(1, "Summarize what the authority asked for").max(5000),
  commentFileId: z.string().uuid().nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  dueOn: isoDate.nullable().optional(),
})

export const updateCorrectionRoundSchema = z.object({
  roundId: z.string().uuid(),
  ownerUserId: z.string().uuid().nullable().optional(),
  dueOn: isoDate.nullable().optional(),
  status: z.enum(["open", "resolved", "withdrawn"]).optional(),
  note: z.string().trim().max(2000).nullable().optional(),
}).refine((value) => value.ownerUserId !== undefined || value.dueOn !== undefined || value.status !== undefined, "Nothing to change")

export const recordPermitDecisionSchema = z.object({
  applicationId: z.string().uuid(),
  decision: z.enum(PERMIT_DECISIONS),
  decidedOn: isoDate,
  permitNumber: z.string().trim().max(80).nullable().optional(),
  issuedOn: isoDate.nullable().optional(),
  expiresOn: isoDate.nullable().optional(),
  issuedPermitFileId: z.string().uuid().nullable().optional(),
  approvedPlansFileId: z.string().uuid().nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
})

export const assessPermitFeeSchema = z.object({
  applicationId: z.string().uuid(),
  kind: z.enum(PERMIT_FEE_KINDS),
  description: z.string().trim().max(300).nullable().optional(),
  amountCents: z.number().int().positive("A fee has an amount"),
  assessedOn: isoDate,
  dueBefore: z.enum(PERMIT_FEE_DUE).nullable().optional(),
  costCodeId: z.string().uuid().nullable().optional(),
  replacesFeeId: z.string().uuid().nullable().optional(),
})

export const voidPermitFeeSchema = z.object({
  feeId: z.string().uuid(),
  reason: z.string().trim().min(10, "Say why in at least 10 characters").max(1000),
})

export const linkPermitFeePaymentSchema = z.object({
  feeId: z.string().uuid(),
  vendorBillId: z.string().uuid().nullable().optional(),
  projectExpenseId: z.string().uuid().nullable().optional(),
}).refine((value) => Boolean(value.vendorBillId) !== Boolean(value.projectExpenseId), "Link one bill or one expense")

/** Pay a fee: a bill from the authority (AP), or a counter payment already made (an expense with its receipt). */
export const payPermitFeeSchema = z.discriminatedUnion("via", [
  z.object({
    via: z.literal("bill"),
    feeId: z.string().uuid(),
    billNumber: z.string().trim().min(1, "The authority's invoice number").max(50),
    billDate: isoDate,
    dueDate: isoDate.nullable().optional(),
  }),
  z.object({
    via: z.literal("expense"),
    feeId: z.string().uuid(),
    paidOn: isoDate,
    paymentMethod: z.enum(["cash", "credit_card", "check", "ach", "company_card", "other"]),
    receiptFileId: z.string().uuid("Attach the receipt"),
  }),
])

export const setPermitJurisdictionProfileSchema = z.object({
  companyId: z.string().uuid(),
  reviewDays: z.number().int().min(1).max(365),
  portalUrl: z.string().trim().url().max(500).nullable().optional(),
  requirements: z.array(z.object({
    permitType: z.enum(PERMIT_TYPES),
    documentKind,
    label: z.string().trim().min(1).max(160),
    requiredFor,
  })).max(60),
})

export const setCommunityPermitAuthoritySchema = z.object({
  communityId: z.string().uuid(),
  companyId: z.string().uuid().nullable(),
})

export const permitQueueFiltersSchema = z.object({
  communityId: z.string().uuid().optional(),
  divisionId: z.string().uuid().optional(),
})
