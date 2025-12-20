import { z } from "zod"

export const proposalLineInputSchema = z.object({
  description: z.string().min(1, "Description is required"),
  quantity: z.number().min(0),
  unit_cost_cents: z.number().min(0),
  line_type: z.enum(["item", "section", "allowance", "option"]).default("item"),
  cost_code_id: z.string().uuid().optional(),
  markup_percent: z.number().optional(),
  is_optional: z.boolean().optional(),
  is_selected: z.boolean().optional(),
  allowance_cents: z.number().optional(),
  notes: z.string().optional(),
})

export const proposalInputSchema = z.object({
  project_id: z.string().uuid(),
  estimate_id: z.string().uuid().optional(),
  recipient_contact_id: z.string().uuid().optional(),
  title: z.string().min(1, "Title is required"),
  summary: z.string().optional(),
  terms: z.string().optional(),
  valid_until: z.string().optional(),
  lines: z.array(proposalLineInputSchema).min(1, "At least one line is required"),
  markup_percent: z.number().optional(),
  tax_rate: z.number().optional(),
  signature_required: z.boolean().optional(),
})

export type ProposalInput = z.infer<typeof proposalInputSchema>
