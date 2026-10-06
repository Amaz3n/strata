import "server-only";
import { z } from "zod";
import { requireBooksWorkspaceEnabled } from "./module";
import { requireBooksAuthorization } from "./access";
import { requireAuthorization } from "@/lib/services/authorization";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { booksDigest } from "./hash";
import {
  nativeAdjustmentRequestSchema,
  nativeAdjustmentFactSchema,
  nativeAdjustmentReviewSchema,
  nativeJournalEntrySchema,
  nativeJournalLineSchema,
  nativePeriodHoldSchema,
  verifyNativeAdjustmentFact,
  verifyNativeAdjustmentReview,
} from "./native-adjustment-contract";
const uuid = z
    .string()
    .uuid()
    .refine((v) => v === v.toLowerCase()),
  note = z.string().trim().min(10).max(2000);
const expected = { expectedOrgId: uuid, expectedActorId: uuid };
const scope = { ...expected, entityId: uuid, projectId: uuid };
async function context(
  v: {
    expectedOrgId: string;
    expectedActorId: string;
    entityId: string;
    projectId?: string;
  },
  operation: "read" | "adjust" | "hold",
) {
  const c = await requireBooksWorkspaceEnabled();
  if (c.orgId !== v.expectedOrgId || c.userId !== v.expectedActorId)
    throw Error(
      "Native accounting request belongs to another organization or actor",
    );
  await requireBooksAuthorization({
    permission:
      operation === "read"
        ? "books.read"
        : operation === "hold"
          ? "books.close"
          : "books.adjust",
    orgId: c.orgId,
    userId: c.userId,
    supabase: c.supabase,
    resourceType: "legal_entity",
    resourceId: v.entityId,
    logDecision: true,
  });
  if (v.projectId)
    await requireAuthorization({
      permission: "project.read",
      orgId: c.orgId,
      userId: c.userId,
      projectId: v.projectId,
      supabase: c.supabase,
      resourceType: "project",
      resourceId: v.projectId,
      logDecision: true,
    });
  return c;
}
async function rpc(name: string, args: Record<string, unknown>) {
  const r = await createServiceSupabaseClient().rpc(name, args);
  if (r.error)
    throw Error(`Native accounting could not complete: ${r.error.message}`);
  return r.data as unknown;
}
export async function prepareNativeProjectAdjustment(input: unknown) {
  const v = z
      .object({
        ...expected,
        id: uuid,
        request: nativeAdjustmentRequestSchema,
        notes: note,
      })
      .strict()
      .parse(input),
    q = v.request.context,
    entity = q.owner.legal_entity_id;
  if (q.orgId !== v.expectedOrgId || q.actorId !== v.expectedActorId)
    throw Error("Native adjustment request context differs from saved actor");
  const c = await context(
    { ...v, entityId: entity, projectId: q.projectId },
    "adjust",
  );
  const response = z
    .object({
      fact: nativeAdjustmentFactSchema,
      posted: z.literal(false),
      ledgerActivated: z.literal(false),
    })
    .parse(
      await rpc("prepare_books_native_adjustment", {
        p_org: c.orgId,
        p_entity: entity,
        p_project: q.projectId,
        p_actor: c.userId,
        p_id: v.id,
        p_request: v.request,
        p_notes: v.notes,
      }),
    );
  const checked = verifyNativeAdjustmentFact(response.fact);
  if (
    checked.fact.id !== v.id ||
    checked.fact.prepared_by !== c.userId ||
    checked.fact.org_id !== c.orgId ||
    checked.fact.legal_entity_id !== entity ||
    checked.fact.project_id !== q.projectId ||
    checked.fact.notes !== v.notes ||
    booksDigest(checked.request) !== booksDigest(v.request)
  )
    throw Error("Native preparation receipt differs from saved request");
  return response;
}
export async function reviewNativeProjectAdjustment(input: unknown) {
  const v = z
      .object({
        ...scope,
        factId: uuid,
        id: uuid,
        decision: z.enum(["approve", "reject"]),
        entryId: uuid.nullable(),
        notes: note,
      })
      .strict()
      .refine((v) => (v.decision === "approve") === (v.entryId !== null))
      .parse(input),
    c = await context(v, "adjust");
  const response = z
    .object({
      fact: nativeAdjustmentFactSchema,
      review: nativeAdjustmentReviewSchema,
      entry: nativeJournalEntrySchema.nullable(),
      lines: z.array(nativeJournalLineSchema),
      posted: z.boolean(),
      created: z.boolean(),
      ledgerActivated: z.literal(false),
    })
    .parse(
      await rpc("review_books_native_adjustment", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_project: v.projectId,
        p_fact: v.factId,
        p_id: v.id,
        p_actor: c.userId,
        p_decision: v.decision,
        p_entry: v.entryId,
        p_notes: v.notes,
      }),
    );
  const checked = verifyNativeAdjustmentReview(
      response.fact,
      response.review,
      response.entry,
      response.lines,
    ),
    r = checked.review;
  if (
    checked.fact.id !== v.factId ||
    checked.fact.org_id !== c.orgId ||
    checked.fact.legal_entity_id !== v.entityId ||
    checked.fact.project_id !== v.projectId ||
    r.id !== v.id ||
    r.reviewed_by !== c.userId ||
    r.decision !== v.decision ||
    r.entry_id !== v.entryId ||
    r.notes !== v.notes ||
    response.posted !== (r.decision === "approve")
  )
    throw Error("Native review receipt differs from saved request");
  return response;
}
export async function readNativeProjectAdjustment(input: unknown) {
  const v = z
      .object({ ...scope, factId: uuid })
      .strict()
      .parse(input),
    c = await context(v, "read");
  const d = z
    .object({
      orgId: uuid,
      entityId: uuid,
      projectId: uuid,
      factId: uuid,
      actorId: uuid,
      fact: nativeAdjustmentFactSchema.nullable(),
      review: nativeAdjustmentReviewSchema.nullable(),
      entry: nativeJournalEntrySchema.nullable(),
      lines: z.array(nativeJournalLineSchema),
    })
    .parse(
      await rpc("read_books_native_adjustment", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_project: v.projectId,
        p_fact: v.factId,
        p_actor: c.userId,
      }),
    );
  if (
    booksDigest([d.orgId, d.entityId, d.projectId, d.factId, d.actorId]) !==
    booksDigest([c.orgId, v.entityId, v.projectId, v.factId, c.userId])
  )
    throw Error("Native adjustment detail differs from scope");
  if (!d.fact) {
    if (d.review || d.entry || d.lines.length)
      throw Error("Native adjustment detail has orphan money");
    return d;
  }
  const f = verifyNativeAdjustmentFact(d.fact).fact;
  if (
    f.id !== v.factId ||
    f.org_id !== c.orgId ||
    f.legal_entity_id !== v.entityId ||
    f.project_id !== v.projectId
  )
    throw Error("Native adjustment detail fact is foreign");
  if (d.review)
    verifyNativeAdjustmentReview(d.fact, d.review, d.entry, d.lines);
  else if (d.entry || d.lines.length)
    throw Error("Native adjustment detail has unreviewed money");
  return d;
}
export async function setNativePeriodPostingHold(input: unknown) {
  const v = z
      .object({
        ...expected,
        entityId: uuid,
        periodId: uuid,
        id: uuid,
        previousId: uuid.nullable(),
        decision: z.enum(["hold", "release"]),
        notes: note,
      })
      .strict()
      .parse(input),
    c = await context(v, "hold");
  const h = nativePeriodHoldSchema.parse(
    await rpc("set_books_native_period_hold", {
      p_org: c.orgId,
      p_entity: v.entityId,
      p_period: v.periodId,
      p_actor: c.userId,
      p_id: v.id,
      p_previous: v.previousId,
      p_decision: v.decision,
      p_notes: v.notes,
    }),
  );
  if (
    h.org_id !== c.orgId ||
    h.legal_entity_id !== v.entityId ||
    h.period_id !== v.periodId ||
    h.id !== v.id ||
    h.actor_id !== c.userId ||
    h.previous_id !== v.previousId ||
    h.decision !== v.decision ||
    h.notes !== v.notes
  )
    throw Error("Native posting hold receipt differs from original request");
  return h;
}
