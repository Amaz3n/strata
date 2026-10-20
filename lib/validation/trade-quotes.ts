import { z } from "zod";

import { DECLINE_REASON_CODES, QUOTE_LOST_REASON_CODES } from "@/lib/sales/lost-reasons";
import { tradeQuoteSchema } from "@/lib/trade/quote";

const id = z.string().uuid();
const optionalText = (max: number) => z.string().trim().max(max).default("");
const instant = z.string().datetime({ offset: true });

export const OPPORTUNITY_SOURCES = ["phone", "email", "referral", "website", "repeat_customer", "other"] as const;

export const OPPORTUNITY_SOURCE_LABELS: Record<(typeof OPPORTUNITY_SOURCES)[number], string> = {
  phone: "Phone call",
  email: "Email",
  referral: "Referral",
  website: "Website",
  repeat_customer: "Repeat customer",
  other: "Other",
};

/** How the opportunity came in, in words; a source this list does not know reads as itself. */
export function opportunitySourceLabel(source: string | null) {
  if (source === "builder_invitation") return "Builder invitation";
  const known = OPPORTUNITY_SOURCES.find((key) => key === source);
  return known ? OPPORTUNITY_SOURCE_LABELS[known] : source || "Added by hand";
}

/** A request for a price someone brought in by hand: the customer, the work, and when the price is due. */
export const tradeOpportunitySchema = z
  .object({
    name: z.string().trim().min(2, "Name the job.").max(200),
    contact_id: id.nullable().default(null),
    customer_name: optionalText(200),
    customer_company: optionalText(200),
    customer_email: z.union([z.literal(""), z.string().trim().email("Enter a valid email.")]).default(""),
    customer_phone: optionalText(40),
    due_at: instant.nullable().default(null),
    address: optionalText(500),
    scope: optionalText(4000),
    source: z.enum(OPPORTUNITY_SOURCES).default("phone"),
  })
  .refine((input) => input.contact_id || input.customer_name || input.customer_company, {
    message: "Choose a customer or enter their name.",
    path: ["customer_name"],
  });
export type TradeOpportunityInput = z.infer<typeof tradeOpportunitySchema>;

export const quoteSaveSchema = z.object({
  prospect_id: id,
  /** The draft being edited; absent for the opportunity's first quote. */
  estimate_id: id.nullable().default(null),
  expected_updated_at: z.string().nullable().default(null),
  quote: tradeQuoteSchema,
});

export const quoteSendSchema = z.object({
  estimate_id: id,
  message: z.string().trim().max(2000).optional(),
});

export const quoteRefSchema = z.object({ estimate_id: id });

/** The customer said yes outside the review link: by phone, email or a signed copy. */
export const quoteAcceptSchema = z.object({
  estimate_id: id,
  accepted_by: z.string().trim().min(2, "Who accepted it?").max(200),
  note: z.string().trim().max(2000).default(""),
});

export const opportunityCloseSchema = z.discriminatedUnion("outcome", [
  z.object({
    prospect_id: id,
    outcome: z.literal("lost"),
    reason_code: z.enum(QUOTE_LOST_REASON_CODES),
    note: z.string().trim().max(2000).default(""),
  }),
  z.object({
    prospect_id: id,
    outcome: z.literal("declined"),
    reason_code: z.enum(DECLINE_REASON_CODES),
    note: z.string().trim().max(2000).default(""),
  }),
]);
export type OpportunityCloseInput = z.infer<typeof opportunityCloseSchema>;

export const opportunityRefSchema = z.object({ prospect_id: id });

export const opportunityDueSchema = z.object({ prospect_id: id, due_at: instant.nullable() });

/** Who the quote goes to. The email is what sending needs; a name or a company says who it is. */
export const opportunityCustomerSchema = z
  .object({
    prospect_id: id,
    name: optionalText(200),
    company: optionalText(200),
    email: z.string().trim().max(254).email("Enter a valid email address.").or(z.literal("")).default(""),
    phone: optionalText(40),
  })
  .refine((value) => value.name || value.company, { message: "Add the customer's name or company.", path: ["name"] });

export const opportunityFollowUpSchema = z.object({
  prospect_id: id,
  at: instant.nullable(),
  note: z.string().trim().max(500).default(""),
});

/** What the office confirms when an accepted quote starts its job; the price and customer come from the quote. */
export const quoteStartJobSchema = z
  .object({
    prospect_id: id,
    name: z.string().trim().min(2).max(200),
    billing_basis: z.enum(["progress", "invoices", "time_and_materials"]),
    retainage_percent: z.number().min(0).max(50),
    payment_terms_days: z.number().int().min(0).max(180),
    customer_certifies: z.boolean(),
    review_before_send: z.boolean(),
    start_date: z.string().date().optional(),
    end_date: z.string().date().optional(),
  })
  .refine((input) => !input.start_date || !input.end_date || input.start_date <= input.end_date, {
    message: "The finish date must be on or after the start date.",
    path: ["end_date"],
  });
export type QuoteStartJobInput = z.infer<typeof quoteStartJobSchema>;
