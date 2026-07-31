import { z } from "zod"

export const structuredFormItemSchema = z.object({
  section: z.string().trim().max(160).nullable().optional(),
  prompt: z.string().trim().min(2).max(1000),
  response_type: z.enum(["pass_fail","yes_no","checkbox","choice","number","text","photo","signature"]),
  options: z.array(z.string().trim().min(1).max(160)).max(50).default([]),
  is_required: z.boolean().default(false),
  blocks_completion: z.boolean().default(false),
})

export const structuredFormTemplateSchema = z.object({
  name: z.string().trim().min(2).max(200),
  kind: z.enum(["safety","quality","action_plan","general"]),
  trade: z.string().trim().max(120).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  items: z.array(structuredFormItemSchema).min(1).max(500),
})

export const structuredFormRunSchema = z.object({
  template_id: z.string().uuid(),
  project_id: z.string().uuid().nullable().optional(),
  lot_id: z.string().uuid().nullable().optional(),
  company_id: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(2).max(300),
})

export const structuredFormResponseSchema = z.object({
  item_id: z.string().uuid(),
  response: z.unknown(),
  is_failed: z.boolean().default(false),
  note: z.string().trim().max(4000).nullable().optional(),
  file_id: z.string().uuid().nullable().optional(),
  signature_file_id: z.string().uuid().nullable().optional(),
})

export const saveStructuredFormResponsesSchema = z.object({
  run_id: z.string().uuid(),
  responses: z.array(structuredFormResponseSchema).min(1).max(500),
})
