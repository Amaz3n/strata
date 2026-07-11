import { z } from "zod"

// ---------------------------------------------------------------------------
// Legacy schedule-item inspection metadata (schedule items of type
// "inspection" store this in metadata). The standalone inspections engine
// below (checklist_templates + inspections tables, lib/services/inspections.ts)
// supersedes it; consolidating the schedule-item type onto the engine is
// recorded follow-up debt.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Standalone inspections engine (workstream 06)
// ---------------------------------------------------------------------------

export const checklistKindSchema = z.enum(["safety", "quality"])
export type ChecklistKind = z.infer<typeof checklistKindSchema>

export const checklistResponseTypeSchema = z.enum(["pass_fail", "yes_no", "text", "number"])

export const checklistTemplateItemInputSchema = z.object({
  section: z.string().trim().max(120).optional().nullable(),
  prompt: z.string().trim().min(1).max(500),
  response_type: checklistResponseTypeSchema.default("pass_fail"),
})

export const checklistTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: checklistKindSchema,
  trade: z.string().trim().max(120).optional().nullable(),
  description: z.string().trim().max(1000).optional().nullable(),
  items: z.array(checklistTemplateItemInputSchema).min(1).max(200),
})
export type ChecklistTemplateInput = z.infer<typeof checklistTemplateInputSchema>

export const createInspectionSchema = z.object({
  project_id: z.string().uuid(),
  template_id: z.string().uuid().optional().nullable(),
  kind: checklistKindSchema,
  title: z.string().trim().min(1).max(200),
  location: z.string().trim().max(200).optional().nullable(),
  company_id: z.string().uuid().optional().nullable(),
})
export type CreateInspectionInput = z.infer<typeof createInspectionSchema>

export const updateInspectionSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  location: z.string().trim().max(200).optional().nullable(),
  company_id: z.string().uuid().optional().nullable(),
  inspector_name: z.string().trim().max(200).optional().nullable(),
  notes: z.string().trim().max(4000).optional().nullable(),
})
export type UpdateInspectionInput = z.infer<typeof updateInspectionSchema>

export const inspectionItemResponseSchema = z.object({
  response: z.string().trim().max(2000).optional().nullable(),
  is_deficient: z.boolean().optional(),
  note: z.string().trim().max(2000).optional().nullable(),
  photo_file_id: z.string().uuid().optional().nullable(),
})
export type InspectionItemResponseInput = z.infer<typeof inspectionItemResponseSchema>

export const inspectionDeficiencyActionSchema = z.object({
  company_id: z.string().uuid().optional().nullable(),
  due_date: z.string().optional().nullable(),
})
export type InspectionDeficiencyActionInput = z.infer<typeof inspectionDeficiencyActionSchema>
