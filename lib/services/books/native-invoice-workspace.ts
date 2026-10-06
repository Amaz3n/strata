import "server-only";
import { z } from "zod";
import { requireOrgContext } from "@/lib/services/context";
import { requireAuthorization } from "@/lib/services/authorization";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { isBooksWorkspaceEnabled } from "./module";
import { requireBooksAuthorization } from "./access";
import { getBooksProjectOwnerWorkspace } from "./project-entity-ownership";
import { readNativeProjectInvoicePosting } from "./native-invoice-posting";

const uuid = z.string().uuid();
/** Discover scope through caller-visible source metadata, never client ownership. */
export async function getNativeInvoiceWorkspace(input: unknown) {
  const v = z.object({ invoiceId: uuid }).strict().parse(input);
  const c = await requireOrgContext();
  if (!(await isBooksWorkspaceEnabled(c.orgId)))
    return { enabled: false as const };
  await requireBooksAuthorization({
    permission: "books.read",
    orgId: c.orgId,
    userId: c.userId,
    supabase: c.supabase,
    resourceType: "accounting_source",
    resourceId: v.invoiceId,
    logDecision: true,
  });
  const root = await c.supabase
    .from("invoices")
    .select("id,org_id,project_id,issue_date")
    .eq("org_id", c.orgId)
    .eq("id", v.invoiceId)
    .maybeSingle();
  if (root.error) throw Error("Invoice accounting source could not load");
  const invoice = z
    .object({
      id: uuid,
      org_id: uuid,
      project_id: uuid.nullable(),
      issue_date: z.string().nullable(),
    })
    .parse(root.data);
  if (invoice.id !== v.invoiceId || invoice.org_id !== c.orgId)
    throw Error("Invoice accounting source differs from requested scope");
  if (!invoice.project_id)
    return {
      enabled: true as const,
      scope: null,
      reason: "Native invoice accounting requires a project assignment.",
    };
  await requireAuthorization({
    permission: "project.read",
    orgId: c.orgId,
    userId: c.userId,
    projectId: invoice.project_id,
    supabase: c.supabase,
    resourceType: "project",
    resourceId: invoice.project_id,
    logDecision: true,
  });
  const workspace = await getBooksProjectOwnerWorkspace({
    projectId: invoice.project_id,
  });
  if (
    workspace.orgId !== c.orgId ||
    workspace.actorId !== c.userId ||
    workspace.projectId !== invoice.project_id
  )
    throw Error("Invoice project ownership differs from requested scope");
  if (!workspace.owner)
    return {
      enabled: true as const,
      scope: null,
      reason:
        "Review the project's legal entity assignment before native posting.",
    };
  const entityId = workspace.owner.review.legal_entity_id;
  const selected = await getBooksProjectOwnerWorkspace({
    projectId: invoice.project_id,
    entityId,
  });
  if (
    selected.orgId !== c.orgId ||
    selected.actorId !== c.userId ||
    selected.projectId !== invoice.project_id ||
    selected.entityId !== entityId ||
    selected.owner?.review.id !== workspace.owner.review.id
  )
    throw Error("Invoice project ownership changed while loading");
  const scope = {
    orgId: c.orgId,
    actorId: c.userId,
    projectId: invoice.project_id,
    entityId,
    invoiceId: invoice.id,
  };
  // Lookup yields only an identity. The private reader rechecks current entity
  // authority and independently validates all original money before disclosure.
  const receipts = await createServiceSupabaseClient()
    .from("books_native_invoice_postings")
    .select("id,legal_entity_id,project_id")
    .eq("org_id", c.orgId)
    .eq("invoice_id", invoice.id)
    .limit(2);
  if (receipts.error)
    throw Error("Native invoice posting status could not load");
  const found = z
    .array(z.object({ id: uuid, legal_entity_id: uuid, project_id: uuid }))
    .max(1)
    .parse(receipts.data);
  if (
    found[0] &&
    (found[0].legal_entity_id !== entityId ||
      found[0].project_id !== invoice.project_id)
  )
    throw Error("Native invoice posting ownership differs from current source");
  const posting = found[0]
    ? await readNativeProjectInvoicePosting({
        expectedOrgId: c.orgId,
        expectedActorId: c.userId,
        projectId: invoice.project_id,
        entityId,
        invoiceId: invoice.id,
        id: found[0].id,
      })
    : null;
  if (found[0] && !posting?.posted)
    throw Error("Native invoice posting detail is unavailable");
  return {
    enabled: true as const,
    scope,
    issueDate: invoice.issue_date,
    canPost: selected.canPrepare,
    posting,
    ledgerActivated: false as const,
  };
}
