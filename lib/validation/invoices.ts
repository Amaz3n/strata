import { z } from "zod"

export const invoiceLineInputSchema = z.object({
  cost_code_id: z.string().uuid().optional(),
  description: z.string().min(1, "Description is required"),
  quantity: z.number({ invalid_type_error: "Quantity is required" }).min(0.01, "Quantity must be greater than zero"),
  unit: z.string().max(20).optional().default("unit"),
  unit_cost: z.number({ invalid_type_error: "Unit cost is required" }).min(0, "Unit cost must be positive"),
  taxable: z.boolean().default(true),
  qbo_income_account_id: z.string().min(1).optional().nullable(),
  qbo_income_account_name: z.string().max(255).optional().nullable(),
})

export const invoiceInputSchema = z.object({
  project_id: z.string().uuid("Project is required").optional().nullable(),
  invoice_number: z.string().min(1, "Invoice number is required"),
  customer_id: z.string().uuid().optional().nullable(),
  customer_name: z.string().optional().nullable(),
  customer_address: z.string().max(500).optional().nullable(),
  from_name: z.string().max(255).optional().nullable(),
  from_email: z.string().max(255).optional().nullable(),
  from_address: z.string().max(500).optional().nullable(),
  reservation_id: z
    .string()
    .uuid()
    .optional()
    .nullable()
    .or(z.literal(""))
    .transform((val) => (val === "" ? undefined : val ?? undefined)),
  title: z.string().min(3, "Title is required"),
  status: z.enum(["draft", "saved", "sent", "partial", "paid", "overdue", "void"]).default("saved"),
  issue_date: z.string().optional(),
  due_date: z.string().optional(),
  notes: z
    .string()
    .max(2000, "Notes are too long")
    .optional()
    .transform((val) => (val && val.trim().length > 0 ? val : undefined)),
  client_visible: z.boolean().default(false),
  tax_rate: z.number().min(0).max(20).default(0),
  lines: z.array(invoiceLineInputSchema).min(1, "Add at least one line item"),
  sent_to_emails: z.array(z.string().email()).optional(),
  payment_terms_days: z.number().min(0).max(365).optional(),
  source_type: z.enum(["manual", "draw", "change_order"]).optional(),
  source_draw_id: z.string().uuid().optional(),
  source_change_order_id: z.string().uuid().optional(),
  qbo_income_account_id: z.string().min(1).optional().nullable(),
  qbo_income_account_name: z.string().max(255).optional().nullable(),
})

export type InvoiceLineInput = z.infer<typeof invoiceLineInputSchema>
export type InvoiceInput = z.infer<typeof invoiceInputSchema>
