import "server-only";
import { z } from "zod";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { authorizeNativeInvoiceScope } from "./native-invoice-posting";
import {
  nativeInvoiceIncomeRequestSchema,
  nativeInvoiceIncomeSelectionSchema,
  verifyNativeInvoiceIncomeSelection,
} from "./native-invoice-income-contract";
import { booksDigest } from "./hash";
import {
  nativeIncomeResolutionInputSchema,
  verifyNativeIncomeResolution,
} from "./native-invoice-income-resolution";
import { verifyNativeInvoiceEconomicContext } from "./native-invoice-economics";
/** Exact saved coding retries do not recapture or adopt later source evidence. */
export async function selectNativeInvoiceIncome(input: unknown) {
  const q = nativeInvoiceIncomeRequestSchema.parse(input),
    n = q.economic.native;
  const c = await authorizeNativeInvoiceScope(
    {
      ...q,
      entityId: n.owner.legal_entity_id,
      projectId: n.projectId,
      invoiceId: n.sourceId,
    },
    true,
  );
  const result = await createServiceSupabaseClient().rpc(
    "select_books_native_invoice_income",
    {
      p_org: c.orgId,
      p_entity: n.owner.legal_entity_id,
      p_project: n.projectId,
      p_actor: c.userId,
      p_request: q,
    },
  );
  if (result.error)
    throw Error(
      `Native invoice income selection could not complete: ${result.error.message}`,
    );
  const r = z
    .object({
      selection: nativeInvoiceIncomeSelectionSchema,
      created: z.boolean(),
      coded: z.literal(true),
      posted: z.literal(false),
      ledgerActivated: z.literal(false),
    })
    .parse(result.data);
  const verified = verifyNativeInvoiceIncomeSelection(r.selection);
  if (booksDigest(q) !== booksDigest(verified.request))
    throw Error(
      "Native invoice income selection differs from original saved request",
    );
  return r;
}
/** Resolve the saved original intent; absence alone never establishes cancellation. */
export async function resolveNativeInvoiceIncome(input: unknown) {
  const q = nativeIncomeResolutionInputSchema.parse(input),
    request = q.request,
    n = request.economic.native;
  verifyNativeInvoiceEconomicContext(request.economic);
  const c = await authorizeNativeInvoiceScope(
    {
      ...request,
      entityId: n.owner.legal_entity_id,
      projectId: n.projectId,
      invoiceId: n.sourceId,
    },
    true,
  );
  const result = await createServiceSupabaseClient().rpc(
    "resolve_books_native_invoice_income",
    {
      p_org: c.orgId,
      p_entity: n.owner.legal_entity_id,
      p_project: n.projectId,
      p_actor: c.userId,
      p_id: q.id,
      p_request: request,
      p_reason: q.reason,
    },
  );
  if (result.error)
    throw Error(
      `Native income request resolution could not complete: ${result.error.message}`,
    );
  return verifyNativeIncomeResolution(result.data, q);
}
