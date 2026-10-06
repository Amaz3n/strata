import { z } from "zod"
import type { InspectionDetail } from "@/lib/services/inspections"

/** Server-controlled cutover. Staged SQL must pass the release gates first. */
export function isInspectionLifecycleEnabled() {
  return process.env.INSPECTION_LIFECYCLE_ENABLED === "true"
}
const uuid = z.string().uuid()
const itemEvidence = z.object({
  id: uuid, inspection_id: uuid, section: z.string().nullable(), prompt: z.string(),
  response_type: z.enum(["pass_fail", "yes_no", "text", "number"]), response: z.string().nullable(),
  is_deficient: z.boolean(), note: z.string().nullable(), photo_file_id: uuid.nullable(), sort_order: z.number().int(),
}).strict()
export const inspectionSourceSchema = z.object({
  id: uuid, project_id: uuid, title: z.string(), kind: z.enum(["safety", "quality"]),
  template_id: uuid.nullable(), location_id: uuid.nullable(), company_id: uuid.nullable(),
  schedule_item_id: uuid.nullable(), notes: z.string().nullable(), location: z.string().nullable(),
  inspector_name: z.string().nullable(), inspection_number: z.number().int().positive(), metadata: z.record(z.string(), z.unknown()), items: z.array(itemEvidence).max(10_000),
}).strict()
export function inspectionReviewSource(detail: InspectionDetail) {
  return inspectionSourceSchema.parse({
    id: detail.id, project_id: detail.project_id, title: detail.title, kind: detail.kind,
    template_id: detail.template_id, location_id: detail.location_id, company_id: detail.company_id,
    schedule_item_id: detail.schedule_item_id, notes: detail.notes, location: detail.location,
    inspector_name: detail.inspector_name, inspection_number: detail.inspection_number, metadata: detail.metadata,
    items: detail.items.map(({ id, inspection_id, section, prompt, response_type, response, is_deficient, note, photo_file_id, sort_order }) =>
      ({ id, inspection_id, section, prompt, response_type, response, is_deficient, note, photo_file_id, sort_order })).sort((a, b) => a.id.localeCompare(b.id)),
  })
}
const common = { inspectionId: uuid, source: inspectionSourceSchema }
export const inspectionLifecycleRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create"), ...common }).strict(),
  z.object({ operation: z.literal("reinspect"), ...common, obligationId: uuid, correctionLinks: z.array(z.object({ failedItemId: uuid, punchId: uuid.nullable() }).strict()).max(10_000), correctionNote: z.string().trim().min(10).max(4000) }).strict(),
  z.object({ operation: z.literal("accept"), ...common, obligationId: uuid, reviewNote: z.string().trim().min(10).max(4000) }).strict(),
  z.object({ operation: z.literal("reject"), ...common, obligationId: uuid, reviewNote: z.string().trim().min(10).max(4000) }).strict(),
])
export const inspectionLifecycleInputSchema = z.object({ key: uuid, request: inspectionLifecycleRequestSchema }).strict()
export type InspectionLifecycleRequest = z.infer<typeof inspectionLifecycleRequestSchema>
export const inspectionLifecycleResponseSchema = z.object({ obligationId: uuid, inspectionId: uuid,
  attemptNumber: z.number().int().positive().optional(), decision: z.enum(["accept", "reject"]).optional() })
export const inspectionCompletionResponseSchema = z.object({ inspectionId: uuid, result: z.enum(["pass", "fail", "partial"]), existing: z.boolean(), awaitingReview: z.boolean() })
const attemptSchema = z.object({ inspection_id: uuid, attempt_number: z.number().int().positive(),
  prior_inspection_id: uuid.nullable(), status: z.enum(["draft", "in_progress", "completed"]), result: z.enum(["pass", "fail", "partial"]).nullable(),
  review_decision: z.enum(["accept", "reject"]).nullable(), correction_evidence: z.unknown(), created_by: uuid, created_at: z.string() })
export const inspectionObligationSchema = z.object({ id: uuid, org_id: uuid, project_id: uuid, title: z.string(),
  source_inspection_id: uuid, accepted_inspection_id: uuid.nullable(), required_for_closing: z.boolean(),
  created_at: z.string(), attempt_count: z.number().int().positive(), attempts: z.array(attemptSchema).max(5) })
export type InspectionObligation = z.infer<typeof inspectionObligationSchema>

export const inspectionObligationPageSchema = z.object({ rows: z.array(inspectionObligationSchema).max(50), nextCursor: uuid.nullable() })

export function inspectionItemNeedsCorrection(item: { is_deficient: boolean; response_type: string; response: string | null }) {
  return item.is_deficient || (item.response_type === "pass_fail" && item.response === "fail")
}
