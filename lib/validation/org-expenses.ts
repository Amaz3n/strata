import { z } from "zod";

import { OVERHEAD_CATEGORIES } from "@/lib/financials/overhead";

const id = z.string().uuid();

export const EXPENSE_PAYMENT_METHODS = [
  "cash",
  "credit_card",
  "check",
  "ach",
  "company_card",
  "reimbursable_personal",
  "other",
] as const;

export const ORG_EXPENSE_QUEUES = ["review", "unsorted", "overhead", "all"] as const;
export type OrgExpenseQueue = (typeof ORG_EXPENSE_QUEUES)[number];

/**
 * Where the cost goes. Exactly one of a job and an overhead category, or
 * neither for a receipt that still needs sorting.
 */
const homeShape = {
  project_id: id.nullable().default(null),
  overhead_category: z.enum(OVERHEAD_CATEGORIES).nullable().default(null),
};

function oneHome(input: { project_id: string | null; overhead_category: string | null }) {
  return !(input.project_id && input.overhead_category);
}
const oneHomeMessage = { message: "Choose a job or an overhead category, not both.", path: ["overhead_category"] };

export const orgExpenseCreateSchema = z
  .object({
    ...homeShape,
    expense_date: z.string().date(),
    amount_cents: z.number().int().positive("Enter the receipt total.").max(1_000_000_000),
    tax_cents: z.number().int().nonnegative().max(1_000_000_000).default(0),
    vendor_name: z.string().trim().max(250).default(""),
    payment_method: z.enum(EXPENSE_PAYMENT_METHODS).nullable().default(null),
    books_payment_account_id: id.nullable().default(null),
    description: z.string().trim().max(5_000).default(""),
    allow_duplicate: z.boolean().default(false),
  })
  .refine(oneHome, oneHomeMessage);
export type OrgExpenseCreateInput = z.infer<typeof orgExpenseCreateSchema>;

export const expenseHomeSchema = z
  .object({
    expense_id: id,
    expected_updated_at: z.string().min(1),
    ...homeShape,
  })
  .refine(oneHome, oneHomeMessage);
export type ExpenseHomeInput = z.infer<typeof expenseHomeSchema>;

export const expenseDecisionSchema = z.object({
  expense_id: id,
  reason: z.string().trim().max(1_000).default(""),
});

export const orgExpenseListSchema = z.object({
  queue: z.enum(ORG_EXPENSE_QUEUES).default("review"),
});
