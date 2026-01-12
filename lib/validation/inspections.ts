import { z } from "zod"

export const inspectionResultSchema = z.enum(["pending", "pass", "fail", "partial"])
export type InspectionResult = z.infer<typeof inspectionResultSchema>

export const inspectionChecklistItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  checked: z.boolean().default(false),
})
export type InspectionChecklistItem = z.infer<typeof inspectionChecklistItemSchema>

export const inspectionInspectorSchema = z.object({
  type: z.enum(["user", "contact", "company"]).optional(),
  id: z.string().uuid().optional(),
  label: z.string().optional(),
})
export type InspectionInspector = z.infer<typeof inspectionInspectorSchema>

export const inspectionMetadataSchema = z.object({
  result: inspectionResultSchema.default("pending"),
  inspector: inspectionInspectorSchema.optional(),
  notes: z.string().optional(),
  checklist: z.array(inspectionChecklistItemSchema).default([]),
  signed_by: z.string().optional(),
  signed_at: z.string().optional(),
})
export type InspectionMetadata = z.infer<typeof inspectionMetadataSchema>

