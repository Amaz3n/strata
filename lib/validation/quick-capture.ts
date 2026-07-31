import { z } from "zod"

export const quickCaptureTargetSchema = z.enum(["punch_item", "observation", "daily_log_note", "task", "rfi_draft"])

export const quickCaptureInputSchema = z.object({
  project_id: z.string().uuid(),
  lot_id: z.string().uuid().nullable().optional(),
  capture_kind: z.enum(["audio", "photo", "video", "text"]),
  source_file_id: z.string().uuid().nullable().optional(),
  attachment_file_ids: z.array(z.string().uuid()).max(10).default([]),
  transcript: z.string().trim().min(2).max(50_000).nullable().optional(),
  preferred_target: quickCaptureTargetSchema.nullable().optional(),
}).superRefine((value, context) => {
  if (value.capture_kind === "text" && !value.transcript) context.addIssue({ code: "custom", path: ["transcript"], message: "Text capture requires content" })
  if (value.capture_kind !== "text" && !value.source_file_id) context.addIssue({ code: "custom", path: ["source_file_id"], message: "Media capture requires a file" })
})

export const quickCaptureExtractedPayloadSchema = z.object({
  target_type: quickCaptureTargetSchema,
  title: z.string().trim().min(2).max(300),
  description: z.string().trim().min(2).max(8000),
  location: z.string().trim().max(200).nullable().default(null),
  due_date: z.string().date().nullable().default(null),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  observation_kind: z.enum(["safety", "quality"]).nullable().default(null),
  observation_category: z.enum(["positive", "at_risk", "deficiency"]).nullable().default(null),
  confidence: z.number().min(0).max(1),
})

export type QuickCaptureInput = z.infer<typeof quickCaptureInputSchema>
export type QuickCaptureExtractedPayload = z.infer<typeof quickCaptureExtractedPayloadSchema>
