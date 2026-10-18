import { z } from "zod"

/** A website delivery's body is capped before it is parsed or stored. */
export const LEAD_SUBMISSION_MAX_BYTES = 32 * 1024

const text = (max: number) => z.string().trim().max(max).optional().nullable()

/**
 * One website lead, as the builder's site posts it. Unknown keys are dropped, so
 * a form vendor's extra fields never reach the database. Contact keys are
 * checked by the filing service (email or phone), not here, so a delivery that
 * names nobody is still recorded and shown to operators as failed.
 */
export const leadSubmissionSchema = z
  .object({
    submission_id: text(200),
    name: text(160),
    first_name: text(80),
    last_name: text(80),
    email: z.string().trim().max(254).email("Enter a valid email").optional().nullable().or(z.literal("")),
    phone: text(50),
    /** An Arc community id or the community's code. */
    community: text(120),
    plan_interest: text(120),
    message: text(4000),
    timeframe: text(120),
    price_range: text(120),
    realtor: z
      .object({
        name: text(160),
        brokerage: text(160),
        email: text(254),
        phone: text(50),
      })
      .strip()
      .optional()
      .nullable(),
    utm_source: text(200),
    utm_medium: text(200),
    utm_campaign: text(200),
    utm_term: text(200),
    utm_content: text(200),
    gclid: text(500),
    fbclid: text(500),
    msclkid: text(500),
    referrer_url: text(2000),
    landing_url: text(2000),
    submitted_at: z.string().datetime({ offset: true }).optional().nullable(),
  })
  .strip()
export type LeadSubmission = z.infer<typeof leadSubmissionSchema>

export const createLeadSourceInputSchema = z.object({
  name: z.string().trim().min(1, "Name the source").max(120),
  defaultSourceLabel: z.string().trim().min(1, "Give leads a source label").max(80),
  defaultCommunityId: z.string().uuid().optional().nullable(),
  defaultOwnerUserId: z.string().uuid().optional().nullable(),
})
export type CreateLeadSourceInput = z.infer<typeof createLeadSourceInputSchema>

export const leadSourceIdSchema = z.string().uuid()

export const setLeadSourceStatusInputSchema = z.object({
  sourceId: z.string().uuid(),
  status: z.enum(["active", "disabled"]),
})

export const leadRoutingRuleInputSchema = z
  .object({
    name: z.string().trim().min(1, "Name the rule").max(120),
    priority: z.coerce.number().int().min(0).max(10_000),
    sourceId: z.string().uuid().optional().nullable(),
    communityId: z.string().uuid().optional().nullable(),
    divisionId: z.string().uuid().optional().nullable(),
    utmSource: z.string().trim().max(200).optional().nullable(),
    utmCampaign: z.string().trim().max(200).optional().nullable(),
    assignedUserId: z.string().uuid({ message: "Choose who gets these leads" }),
  })
  .refine(
    (rule) => Boolean(rule.sourceId || rule.communityId || rule.divisionId || rule.utmSource || rule.utmCampaign),
    { message: "A rule needs at least one condition; the community rotation already covers every lead." },
  )
export type LeadRoutingRuleInput = z.infer<typeof leadRoutingRuleInputSchema>

export const divisionLeadOwnerInputSchema = z.object({
  divisionId: z.string().uuid(),
  ownerUserId: z.string().uuid().nullable(),
})

export const leadReceiptIdSchema = z.string().uuid()

export const dismissLeadReceiptInputSchema = z.object({
  receiptId: z.string().uuid(),
  note: z.string().trim().min(3, "Say why this lead is dismissed").max(500),
})
export type DismissLeadReceiptInput = z.infer<typeof dismissLeadReceiptInputSchema>
