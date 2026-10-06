import { z } from "zod";
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const note = z
  .string()
  .min(10)
  .max(2000)
  .refine((v) => v === v.trim());
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + "T00:00:00Z");
    return (
      Number.isFinite(d.valueOf()) &&
      d.toISOString().slice(0, 10) === v &&
      v >= "1900-01-01" &&
      v <= "9997-12-31"
    );
  });
const bytes = z.union([
  z.number().int().safe().nonnegative(),
  z.string().regex(/^(0|[1-9][0-9]*)$/),
]);
export const projectOwnershipDecisionSchema = z
  .object({
    single_entity_project_confirmed: z.literal(true),
    rationale: note,
    document_version_ids: z
      .array(uuid)
      .min(1)
      .max(50)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
const document = z
  .object({
    id: uuid,
    file_id: uuid,
    storage_path: z.string().min(1),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    size_bytes: bytes,
  })
  .strict();
export const projectOwnershipProposalSchema = z.object({
  id: uuid,
  org_id: uuid,
  project_id: uuid,
  legal_entity_id: uuid,
  profile_id: uuid,
  effective_on: date,
  project_name: z.string().min(1),
  decision_evidence: projectOwnershipDecisionSchema,
  documents: z.array(document).min(1).max(50),
  prepared_by: uuid,
  prepared_at: z.string(),
  prepared_access_event_id: uuid,
  preparation_notes: note,
});
export const projectOwnershipReviewSchema = z.object({
  id: uuid,
  org_id: uuid,
  project_id: uuid,
  legal_entity_id: uuid,
  proposal_id: uuid,
  reviewed_by: uuid,
  reviewed_at: z.string(),
  reviewed_access_event_id: uuid,
  review_notes: note,
});

export const projectOwnerResolutionSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  project_id: uuid,
  actor_id: uuid,
  kind: z.enum(["prepare", "review"]),
  request_id: uuid,
  request_text: z.string().max(65536),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  reason: note,
  resolved_at: z.string(),
  resolved_access_event_id: uuid,
  observed_proposal_id: uuid.nullable(),
});
