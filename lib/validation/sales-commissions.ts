import { z } from "zod"

import { MAX_COMMISSION_RATE_BPS } from "@/lib/financials/sales-commissions"

const terms = {
  basis: z.enum(["percent_of_authorized_price", "flat"]),
  rateBps: z.number().int().min(1).max(MAX_COMMISSION_RATE_BPS).nullable(),
  flatCents: z.number().int().safe().positive().nullable(),
}

const termsMatchBasis = (line: { basis: string; rateBps: number | null; flatCents: number | null }) =>
  line.basis === "flat" ? line.flatCents !== null && line.rateBps === null : line.rateBps !== null && line.flatCents === null

export const commissionLineSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("coop_broker"),
    payeeCompanyId: z.string().uuid(),
    agentName: z.string().trim().min(1).max(200).nullable(),
    ...terms,
  }),
  z.object({
    kind: z.literal("sales_consultant"),
    payeeUserId: z.string().uuid(),
    // A W-2 consultant is paid through payroll; a 1099 consultant through their own company.
    payoutChannel: z.enum(["payroll", "accounts_payable"]),
    payeeCompanyId: z.string().uuid().nullable(),
    ...terms,
  }),
]).refine(termsMatchBasis, { message: "Give a rate for a percentage commission, or an amount for a flat one", path: ["basis"] })
  .refine((line) => line.kind === "coop_broker" || (line.payoutChannel === "accounts_payable") === (line.payeeCompanyId !== null), {
    message: "A consultant paid as a vendor needs their company; one paid through payroll does not",
    path: ["payeeCompanyId"],
  })

export type CommissionLineInput = z.infer<typeof commissionLineSchema>

export const commissionPlanSchema = z.object({
  coopBroker: z.enum(["none", "broker"]),
  lines: z.array(commissionLineSchema).max(10),
}).refine((plan) => (plan.coopBroker === "broker") === plan.lines.some((line) => line.kind === "coop_broker"), {
  message: "Name the co-op broker's terms, or declare no co-op broker",
  path: ["coopBroker"],
})

export type CommissionPlanInput = z.infer<typeof commissionPlanSchema>

export const proposeCommissionPlanSchema = z.object({
  contractId: z.string().uuid(),
  plan: commissionPlanSchema,
  reason: z.string().trim().min(8).max(1000).nullable().optional(),
})

export const approveCommissionPlanSchema = z.object({
  planId: z.string().uuid(),
  note: z.string().trim().max(1000).nullable().optional(),
})

export const markPayrollCommissionPaidSchema = z.object({
  obligationId: z.string().uuid(),
  payrollReference: z.string().trim().min(1).max(200),
  paidOn: z.string().date(),
})

export const commissionPayeeSearchSchema = z.object({
  search: z.string().trim().max(100).default(""),
  page: z.number().int().min(1).max(50).default(1),
})
