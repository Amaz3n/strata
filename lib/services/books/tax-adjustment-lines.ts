import { z } from "zod"
import { taxAttachmentSnapshotSchema } from "./tax-attachment-rules"

export const taxAdjustmentLineSchema = z.object({
  id: z.string().uuid(), kind: z.enum(["permanent", "timing"]),
  amount_cents: z.number().int().safe().refine(value => value !== 0, "Adjustment cannot be zero"),
  description: z.string().trim().min(10).max(2000), evidence_reference: z.string().trim().min(3).max(2000),
  evidence_file_id: z.string().uuid().nullable().default(null), project_id: z.string().uuid().nullable().default(null),
  evidence_snapshot: taxAttachmentSnapshotSchema.nullable().optional(),
}).superRefine((line,context) => {
  if (line.evidence_snapshot && line.evidence_snapshot.file_id !== line.evidence_file_id) context.addIssue({ code: z.ZodIssueCode.custom, message: "Tax attachment does not belong to referenced file" })
})
export const taxAdjustmentLinesSchema = z.array(taxAdjustmentLineSchema).max(500).superRefine((lines,context) => {
  if (new Set(lines.map(line => line.id)).size !== lines.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate tax adjustment identity" })
})
export const taxWorkpaperEvidenceSchema = z.object({ lines: taxAdjustmentLinesSchema, preparation_notes: z.string().trim().max(2000).default("") }).superRefine((workpaper,context) => {
  if (workpaper.lines.length === 0 && workpaper.preparation_notes.length < 10) context.addIssue({ code: z.ZodIssueCode.custom, path: ["preparation_notes"], message: "Explain and cite the evidence supporting no tax adjustments" })
})
function safe(value: bigint) { const result = Number(value); if (!Number.isSafeInteger(result)) throw new Error("Tax workpaper exceeds safe integer cents"); return result }
export function totalTaxAdjustments(input: unknown) {
  const lines = taxAdjustmentLinesSchema.parse(input)
  const permanent = lines.filter(line => line.kind === "permanent").reduce((sum,line) => sum + BigInt(line.amount_cents), BigInt(0))
  const timing = lines.filter(line => line.kind === "timing").reduce((sum,line) => sum + BigInt(line.amount_cents), BigInt(0))
  return { lines, permanentCents: safe(permanent), timingCents: safe(timing), totalCents: safe(permanent + timing) }
}
