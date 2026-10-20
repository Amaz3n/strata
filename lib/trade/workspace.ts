import { z } from "zod";

const day = z.string().date();
export const tradeJobSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    client_id: z.string().uuid().optional(),
    address: z.string().trim().max(500).default(""),
    description: z.string().trim().max(4000).default(""),
    property_type: z.enum(["residential", "commercial"]).default("residential"),
    customer_kind: z.enum(["company", "homeowner"]).default("homeowner"),
    billing_basis: z
      .enum(["progress", "invoices", "time_and_materials"])
      .default("invoices"),
    retainage_percent: z.number().min(0).max(50).default(0),
    payment_terms_days: z.number().int().min(0).max(180).default(30),
    review_before_send: z.boolean().default(false),
    customer_certifies: z.boolean().default(false),
    total_contract_value_cents: z
      .number()
      .int()
      .min(0)
      .max(2_147_483_647)
      .optional(),
    start_date: day.optional(),
    end_date: day.optional(),
  })
  .refine(
    (input) =>
      !input.start_date ||
      !input.end_date ||
      input.start_date <= input.end_date,
    {
      message: "The finish date must be on or after the start date.",
      path: ["end_date"],
    },
  );

export type TradeJobInput = z.infer<typeof tradeJobSchema>;
export type TradeBillingBasis = TradeJobInput["billing_basis"];

/**
 * What the new-job form suggests once the customer is known: a builder or GC
 * usually wants a pay application against a schedule of values, holds
 * retainage and certifies; a homeowner gets plain invoices.
 */
export type TradeJobBillingChoices = Pick<
  TradeJobInput,
  "billing_basis" | "retainage_percent" | "payment_terms_days" | "customer_certifies"
>;
export function tradeJobBillingDefaults(
  customerKind: TradeJobInput["customer_kind"],
): TradeJobBillingChoices {
  return customerKind === "company"
    ? { billing_basis: "progress", retainage_percent: 10, payment_terms_days: 30, customer_certifies: true }
    : { billing_basis: "invoices", retainage_percent: 0, payment_terms_days: 15, customer_certifies: false };
}

const TRADE_BILLING_BASES: readonly TradeBillingBasis[] = ["progress", "invoices", "time_and_materials"];
export function isTradeBillingBasis(value: string): value is TradeBillingBasis {
  return TRADE_BILLING_BASES.some((basis) => basis === value);
}

/**
 * The project billing fields a trade job's answers set. Progress and invoices
 * are both a fixed contract; progress bills it by pay application against a
 * schedule of values, invoices by draws. Certification only means something
 * for a pay application.
 */
export function tradeJobBilling(data: TradeJobInput) {
  const timeAndMaterials = data.billing_basis === "time_and_materials";
  return {
    billing_model: timeAndMaterials ? ("time_and_materials" as const) : ("fixed_price" as const),
    contract_type: timeAndMaterials ? ("time_materials" as const) : ("fixed" as const),
    fixed_price_billing_basis: data.billing_basis === "progress" ? ("progress" as const) : ("draws" as const),
    retainage_percent: data.retainage_percent,
    receivables_terms: {
      customerKind: data.customer_kind,
      paymentTermsDays: data.payment_terms_days,
      reviewBeforeSend: data.review_before_send,
      customerCertifies: data.billing_basis === "progress" && data.customer_certifies,
    },
  };
}

export const tradeWorkSchema = z
  .object({
    project_id: z.string().uuid(),
    name: z.string().trim().min(2).max(200),
    start_date: day,
    end_date: day,
    assigned_to: z.string().uuid().optional(),
    planned_hours: z.number().positive().max(10000).optional(),
    notes: z.string().trim().max(2000).default(""),
  })
  .refine((input) => input.start_date <= input.end_date, {
    message: "The finish date must be on or after the start date.",
    path: ["end_date"],
  });

export const ELECTRICAL_WORK = [
  "Underground & service",
  "Rough-in",
  "Rough inspection",
  "Trim-out",
  "Fixtures & devices",
  "Testing & final inspection",
  "Punch & closeout",
];

export interface CrewWork {
  id: string;
  project_id: string;
  name: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  assigned_to: string | null;
  planned_hours: number | null;
}

/** Inclusive dates: two jobs on the same day are a conflict for one lead. */
export function crewConflicts(items: CrewWork[]): Set<string> {
  const result = new Set<string>();
  const live = items.filter(
    (item) =>
      item.assigned_to &&
      item.start_date &&
      !["completed", "cancelled"].includes(item.status),
  );
  for (let a = 0; a < live.length; a++) {
    for (let b = a + 1; b < live.length; b++) {
      const left = live[a],
        right = live[b];
      if (
        left.assigned_to !== right.assigned_to ||
        left.project_id === right.project_id
      )
        continue;
      const leftStart = left.start_date,
        rightStart = right.start_date;
      if (
        leftStart &&
        rightStart &&
        leftStart <= (right.end_date ?? rightStart) &&
        rightStart <= (left.end_date ?? leftStart)
      ) {
        result.add(left.id);
        result.add(right.id);
      }
    }
  }
  return result;
}
