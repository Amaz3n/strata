import "server-only";
import { z } from "zod";
import { requireBooksWorkspaceEnabled } from "./module";
import { requireBooksAuthorization } from "./access";
import { requireAuthorization } from "@/lib/services/authorization";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { booksDigest } from "./hash";
import { nativeInvoicePostingRequestSchema } from "./native-invoice-request";
export { nativeInvoicePostingRequestSchema } from "./native-invoice-request";
import { nativeJournalLineSchema } from "./native-adjustment-contract";
import {
  nativeInvoicePostingSchema,
  nativeInvoiceJournalEntrySchema,
  verifyNativeInvoicePostingReceipt,
} from "./native-invoice-posting-receipt";
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const expected = { expectedOrgId: uuid, expectedActorId: uuid };
const scope = {
  ...expected,
  entityId: uuid,
  projectId: uuid,
  invoiceId: uuid,
  id: uuid,
};
export async function authorizeNativeInvoiceScope(
  v: z.infer<z.ZodObject<typeof scope>>,
  write: boolean,
) {
  const c = await requireBooksWorkspaceEnabled();
  if (c.orgId !== v.expectedOrgId || c.userId !== v.expectedActorId)
    throw Error(
      "Native invoice request belongs to another organization or actor",
    );
  await requireBooksAuthorization({
    permission: write ? "books.manage" : "books.read",
    orgId: c.orgId,
    userId: c.userId,
    supabase: c.supabase,
    resourceType: "accounting_source",
    resourceId: v.invoiceId,
    logDecision: true,
  });
  // Caller RLS visibility and the actual project precede every private operation.
  // Do not reload source economics: a committed old request must remain recoverable.
  const root = await c.supabase
    .from("invoices")
    .select("id,org_id,project_id")
    .eq("org_id", c.orgId)
    .eq("id", v.invoiceId)
    .maybeSingle();
  if (root.error) throw Error("Native invoice source could not load");
  const invoice = z
    .object({ id: uuid, org_id: uuid, project_id: uuid })
    .parse(root.data);
  if (
    invoice.org_id !== c.orgId ||
    invoice.id !== v.invoiceId ||
    invoice.project_id !== v.projectId
  )
    throw Error("Native invoice actual source differs from saved scope");
  await requireAuthorization({
    permission: write ? "project.manage" : "project.read",
    orgId: c.orgId,
    userId: c.userId,
    projectId: invoice.project_id,
    supabase: c.supabase,
    resourceType: "project",
    resourceId: invoice.project_id,
    logDecision: true,
  });
  return c;
}
async function rpc(name: string, args: Record<string, unknown>) {
  const r = await createServiceSupabaseClient().rpc(name, args);
  if (r.error)
    throw Error(
      `Native invoice operation could not complete: ${r.error.message}`,
    );
  return r.data as unknown;
}
/** Uses the exact saved nonce/header/economic body; never recaptures a retry. */
export async function postNativeProjectInvoice(input: unknown) {
  const v = nativeInvoicePostingRequestSchema.parse(input),
    q = v.economic.native;
  if (
    q.orgId !== v.expectedOrgId ||
    q.actorId !== v.expectedActorId ||
    q.sourceType !== "invoice"
  )
    throw Error(
      "Native invoice saved witness differs from original actor/source",
    );
  const entity = q.owner.legal_entity_id;
  const c = await authorizeNativeInvoiceScope(
    { ...v, entityId: entity, projectId: q.projectId, invoiceId: q.sourceId },
    true,
  );
  const r = z
    .object({
      posting: nativeInvoicePostingSchema,
      entry: nativeInvoiceJournalEntrySchema,
      lines: z.array(nativeJournalLineSchema).max(1000),
      created: z.boolean(),
      posted: z.literal(true),
      ledgerActivated: z.literal(false),
    })
    .parse(
      await rpc("post_books_native_invoice", {
        p_org: c.orgId,
        p_entity: entity,
        p_project: q.projectId,
        p_actor: c.userId,
        p_id: v.id,
        p_entry: v.entryId,
        p_economic: v.economic,
        p_notes: v.notes,
      }),
    );
  const checked = verifyNativeInvoicePostingReceipt(
      r.posting,
      r.entry,
      r.lines,
    ),
    p = checked.posting;
  if (
    p.id !== v.id ||
    p.entry_id !== v.entryId ||
    p.org_id !== c.orgId ||
    p.legal_entity_id !== entity ||
    p.project_id !== q.projectId ||
    p.invoice_id !== q.sourceId ||
    p.posted_by !== c.userId ||
    p.notes !== v.notes ||
    booksDigest(JSON.parse(p.request_text)) !== booksDigest(v.economic)
  )
    throw Error(
      "Native invoice posting receipt differs from exact saved request",
    );
  return r;
}
export async function readNativeProjectInvoicePosting(input: unknown) {
  const v = z.object(scope).strict().parse(input),
    c = await authorizeNativeInvoiceScope(v, false);
  const r = z
    .object({
      orgId: uuid,
      entityId: uuid,
      projectId: uuid,
      id: uuid,
      actorId: uuid,
      posting: nativeInvoicePostingSchema.nullable(),
      entry: nativeInvoiceJournalEntrySchema.nullable(),
      lines: z.array(nativeJournalLineSchema).max(1000),
    })
    .parse(
      await rpc("read_books_native_invoice_posting", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_project: v.projectId,
        p_id: v.id,
        p_actor: c.userId,
      }),
    );
  if (
    booksDigest([r.orgId, r.entityId, r.projectId, r.id, r.actorId]) !==
    booksDigest([c.orgId, v.entityId, v.projectId, v.id, c.userId])
  )
    throw Error("Native invoice detail differs from requested scope");
  if (!r.posting) {
    if (r.entry || r.lines.length)
      throw Error("Native invoice detail contains orphan money");
    return { ...r, posted: false as const, ledgerActivated: false as const };
  }
  const p = verifyNativeInvoicePostingReceipt(
    r.posting,
    r.entry,
    r.lines,
  ).posting;
  if (
    p.id !== v.id ||
    p.org_id !== c.orgId ||
    p.legal_entity_id !== v.entityId ||
    p.project_id !== v.projectId ||
    p.invoice_id !== v.invoiceId
  )
    throw Error("Native invoice detail belongs to another source");
  return { ...r, posted: true as const, ledgerActivated: false as const };
}

/** Absence is never cancellation: the entity/project/source/nonce fence chooses
 * one committed original receipt or one retained cancellation atomically. */
export async function resolveNativeProjectInvoiceRequest(input: unknown) {
  const v = z
      .object({
        id: uuid,
        request: nativeInvoicePostingRequestSchema,
        reason: z.string().trim().min(10).max(2000),
      })
      .strict()
      .parse(input),
    q = v.request.economic.native;
  if (
    q.orgId !== v.request.expectedOrgId ||
    q.actorId !== v.request.expectedActorId ||
    q.sourceType !== "invoice"
  )
    throw Error(
      "Native invoice resolution witness differs from original actor/source",
    );
  const entity = q.owner.legal_entity_id;
  const c = await authorizeNativeInvoiceScope(
    {
      ...v.request,
      entityId: entity,
      projectId: q.projectId,
      invoiceId: q.sourceId,
    },
    true,
  );
  const { nativeInvoiceResolutionSchema, verifyNativeInvoiceResolution } =
    await import("./native-invoice-resolution");
  const r = z
    .discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("cancelled"),
        resolution: nativeInvoiceResolutionSchema,
        posting: z.null(),
        entry: z.null(),
        lines: z.array(nativeJournalLineSchema).length(0),
        posted: z.literal(false),
        ledgerActivated: z.literal(false),
      }),
      z.object({
        outcome: z.literal("committed_original"),
        resolution: z.null(),
        posting: nativeInvoicePostingSchema,
        entry: nativeInvoiceJournalEntrySchema,
        lines: z.array(nativeJournalLineSchema).max(1000),
        posted: z.literal(true),
        ledgerActivated: z.literal(false),
      }),
    ])
    .parse(
      await rpc("resolve_books_native_invoice_request", {
        p_org: c.orgId,
        p_entity: entity,
        p_project: q.projectId,
        p_actor: c.userId,
        p_id: v.id,
        p_request: v.request,
        p_reason: v.reason,
      }),
    );
  if (r.outcome === "cancelled") {
    const checked = verifyNativeInvoiceResolution(r.resolution);
    if (
      checked.resolution.id !== v.id ||
      checked.resolution.reason !== v.reason ||
      booksDigest(checked.request) !== booksDigest(v.request)
    )
      throw Error("Native invoice cancellation differs from saved resolution");
  } else {
    const p = verifyNativeInvoicePostingReceipt(
      r.posting,
      r.entry,
      r.lines,
    ).posting;
    if (
      p.id !== v.request.id ||
      p.entry_id !== v.request.entryId ||
      p.org_id !== c.orgId ||
      p.legal_entity_id !== entity ||
      p.project_id !== q.projectId ||
      p.invoice_id !== q.sourceId ||
      p.posted_by !== c.userId ||
      p.notes !== v.request.notes ||
      booksDigest(JSON.parse(p.request_text)) !==
        booksDigest(v.request.economic)
    )
      throw Error(
        "Native invoice resolution committed receipt differs from saved request",
      );
  }
  return r;
}
