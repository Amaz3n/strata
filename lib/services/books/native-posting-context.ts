import {
  verifyNativeInvoiceEconomicContext,
  buildNativeInvoicePostingPlan,
} from "./native-invoice-economics";
import "server-only";
import { z } from "zod";
import { requireBooksWorkspaceEnabled } from "./module";
import { requireBooksAuthorization } from "./access";
import { requireAuthorization } from "@/lib/services/authorization";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import {
  nativePostingContextSchema,
  verifyNativeProjectPostingContext,
} from "./native-posting-plan";
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const inputSchema = z
  .object({
    expectedOrgId: uuid,
    expectedActorId: uuid,
    sourceType: z.enum(["invoice", "vendor_bill", "expense"]),
    sourceId: uuid,
    entryDate: nativePostingContextSchema.shape.entryDate,
  })
  .strict();
/** Source metadata is read through the caller's RLS client before loading the
 * privileged snapshot; actual project management precedes the private RPC. */
export function loadNativeProjectPostingContext(input: unknown) {
  return loadContext(input, "books.manage", "project.manage").then(
    (r) => r.context,
  );
}
export function loadNativeProjectAdjustmentContext(input: unknown) {
  return loadContext(input, "books.adjust", "project.read").then(
    (r) => r.context,
  );
}
export async function loadNativeInvoiceEconomicContext(input: unknown) {
  const v = inputSchema.parse(input);
  if (v.sourceType !== "invoice")
    throw Error("Native invoice economics require an invoice");
  const r = await loadContext(v, "books.manage", "project.manage", true);
  return verifyNativeInvoiceEconomicContext(r.data).economic;
}
export async function previewNativeProjectInvoicePosting(input: unknown) {
  return buildNativeInvoicePostingPlan(
    await loadNativeInvoiceEconomicContext(input),
  );
}
async function loadContext(
  input: unknown,
  booksPermission: "books.manage" | "books.adjust",
  projectPermission: "project.manage" | "project.read",
  economic = false,
) {
  const v = inputSchema.parse(input),
    c = await requireBooksWorkspaceEnabled();
  if (v.expectedOrgId !== c.orgId || v.expectedActorId !== c.userId)
    throw Error(
      "Native posting context belongs to another organization or actor",
    );
  await requireBooksAuthorization({
    permission: booksPermission,
    orgId: c.orgId,
    userId: c.userId,
    supabase: c.supabase,
    resourceType: "accounting_source",
    resourceId: v.sourceId,
    logDecision: true,
  });
  const table =
    v.sourceType === "invoice"
      ? "invoices"
      : v.sourceType === "vendor_bill"
        ? "vendor_bills"
        : "project_expenses";
  const root = await c.supabase
    .from(table)
    .select("id,org_id,project_id")
    .eq("org_id", c.orgId)
    .eq("id", v.sourceId)
    .maybeSingle();
  if (root.error) throw Error("Native accounting source could not load");
  const source = z
    .object({ id: uuid, org_id: uuid, project_id: uuid })
    .parse(root.data);
  if (source.org_id !== c.orgId || source.id !== v.sourceId)
    throw Error("Native accounting source differs from request scope");
  await requireAuthorization({
    permission: projectPermission,
    orgId: c.orgId,
    userId: c.userId,
    projectId: source.project_id,
    supabase: c.supabase,
    resourceType: "project",
    resourceId: source.project_id,
    logDecision: true,
  });
  const result = await createServiceSupabaseClient().rpc(
    economic
      ? "read_books_native_invoice_economic_context"
      : "read_books_native_project_posting_context",
    {
      p_org: c.orgId,
      p_project: source.project_id,
      p_source_type: v.sourceType,
      p_source_id: v.sourceId,
      p_actor: c.userId,
      p_entry_date: v.entryDate,
    },
  );
  if (result.error)
    throw Error(
      `Native source routing could not complete: ${result.error.message}`,
    );
  const data = result.data as unknown;
  const context = nativePostingContextSchema.parse(
    economic ? (data as { native: unknown })?.native : data,
  );
  if (
    context.orgId !== c.orgId ||
    context.actorId !== c.userId ||
    context.projectId !== source.project_id ||
    context.sourceType !== v.sourceType ||
    context.sourceId !== v.sourceId ||
    context.entryDate !== v.entryDate
  )
    throw Error("Native source routing receipt differs from requested scope");
  return { data, context: verifyNativeProjectPostingContext(context).context };
}
