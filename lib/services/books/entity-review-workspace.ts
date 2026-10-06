import "server-only";
import { z } from "zod";
import { requireBooksWorkspaceEnabled } from "./module";
import { requireBooksAuthorization } from "./access";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { readBooksLegacyEntityProposal } from "./legacy-entity-ownership-service";
import { parseLegacyOwnershipPopulation } from "./legacy-entity-ownership";
const uuid = z.string().uuid();
async function context(
  entityId: string,
  permission: "books.read" | "books.manage",
  exportRequired = true,
) {
  const c = await requireBooksWorkspaceEnabled();
  for (const p of exportRequired ? [permission, "books.export"] : [permission])
    await requireBooksAuthorization({
      permission: p,
      orgId: c.orgId,
      userId: c.userId,
      supabase: c.supabase,
      resourceType: "legal_entity",
      resourceId: entityId,
      logDecision: true,
    });
  return c;
}
async function call(name: string, args: Record<string, unknown>) {
  const r = await createServiceSupabaseClient().rpc(name, args);
  if (r.error)
    throw new Error(
      `Entity review workspace could not load: ${r.error.message}`,
    );
  return r.data as unknown;
}
export async function listBooksEntityProposals(input: unknown) {
  const v = z
      .object({ entityId: uuid, after: uuid.optional() })
      .strict()
      .parse(input),
    c = await context(v.entityId, "books.read");
  return z
    .object({
      orgId: z.literal(c.orgId),
      entityId: z.literal(v.entityId),
      actorId: z.literal(c.userId),
      accessLevel: z.enum(["read", "prepare", "review", "manage"]),
      latestReviewedProposalId: uuid.nullable(),
      nextCursor: uuid.nullable(),
      proposals: z
        .array(
          z.object({
            id: uuid,
            org_id: z.literal(c.orgId),
            legal_entity_id: z.literal(v.entityId),
            accounting_cutoff: z.string(),
            prepared_at: z.string(),
            prepared_by: uuid,
            prepared_by_name: z.string(),
            reviewed_at: z.string().nullable(),
            reviewed_by: uuid.nullable(),
            reviewed_by_name: z.string(),
          }),
        )
        .max(25),
    })
    .parse(
      await call("list_books_legacy_entity_proposals", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_actor: c.userId,
        p_after: v.after ?? null,
        p_limit: 25,
      }),
    );
}
export async function listBooksEntityReviewOptions(input: unknown) {
  const v = z
      .object({
        entityId: uuid,
        kind: z.enum(["people", "documents"]),
        search: z.string().max(100).default(""),
        after: uuid.optional(),
      })
      .strict()
      .parse(input),
    c = await context(
      v.entityId,
      v.kind === "people" ? "books.manage" : "books.read",
      v.kind === "documents",
    );
  return z
    .object({
      orgId: z.literal(c.orgId),
      entityId: z.literal(v.entityId),
      kind: z.literal(v.kind),
      nextCursor: uuid.nullable(),
      options: z
        .array(z.object({ id: uuid, label: z.string(), detail: z.string() }))
        .max(25),
    })
    .parse(
      await call("list_books_entity_review_options", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_actor: c.userId,
        p_kind: v.kind,
        p_search: v.search,
        p_after: v.after ?? null,
        p_limit: 25,
      }),
    );
}
export async function getBooksEntitySetupAccess(entityId: string) {
  const id = uuid.parse(entityId),
    c = await context(id, "books.read", false);
  return z
    .object({
      orgId: z.literal(c.orgId),
      entityId: z.literal(id),
      actorId: z.literal(c.userId),
      prepare: z.boolean(),
      review: z.boolean(),
      manage: z.boolean(),
    })
    .parse(
      await call("read_books_entity_setup_access", {
        p_org: c.orgId,
        p_entity: id,
        p_actor: c.userId,
      }),
    );
}
export async function getBooksEntityProposalReview(input: unknown) {
  const v = z
    .object({ entityId: uuid, proposalId: uuid })
    .strict()
    .parse(input);
  await context(v.entityId, "books.read");
  const detail = await readBooksLegacyEntityProposal(v),
    p = detail.proposal,
    population = parseLegacyOwnershipPopulation(p);
  // The full frozen population may contain payroll and private source evidence.
  // The review UI receives counts/provenance and selected originals, not its rows.
  return {
    id: p.id,
    entityId: p.legal_entity_id,
    preparedBy: p.prepared_by,
    cutoff: p.accounting_cutoff,
    rationale: p.decision_evidence.rationale,
    notes: p.preparation_notes,
    preparedAt: p.prepared_at,
    capturedAt: p.source_captured_at,
    sourcePopulationCurrent: detail.sourcePopulationCurrent,
    review: detail.review
      ? {
          id: detail.review.id,
          reviewedBy: detail.review.reviewed_by,
          reviewedAt: detail.review.reviewed_at,
          notes: detail.review.review_notes,
        }
      : null,
    populations: Object.entries(population).map(([table, rows]) => ({
      table,
      rows: rows.length,
    })),
    documents: p.decision_evidence.document_version_ids.map((id) => {
      const d = population.doc_versions.find((row) => row.id === id)!;
      return {
        id,
        name: String(d.file_name),
        checksum: String(d.checksum),
        sizeBytes: Number(d.size_bytes),
      };
    }),
    approvedForLedgerActivation: false as const,
  };
}
