import "server-only";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import {
  isPrivatePayrollPath,
  requirePrivatePayrollRead,
} from "@/lib/storage/payroll-private-storage";

/** Private legacy file paths also require accounting access, even through a
 * portal or generic service-role byte reader that bypasses file RLS. */
export async function assertPayrollDocumentStorageRead(
  orgId: string,
  path: string,
) {
  if (isPrivatePayrollPath(path)) {
    await requirePrivatePayrollRead(orgId);
    return;
  }
  const r = await createServiceSupabaseClient().rpc(
    "is_books_private_payroll_object",
    { p_org_id: orgId, p_path: path },
  );
  if (r.error || typeof r.data !== "boolean")
    throw new Error("Document privacy could not be verified");
  if (r.data) await requirePrivatePayrollRead(orgId);
}

/** Generic preview/download routes must not expose private document metadata or
 * cached previews. Authorized accountants use the payroll workflow instead. */
export async function isPayrollDocumentPrivate(orgId: string, path: string) {
  if (isPrivatePayrollPath(path)) return true;
  const r = await createServiceSupabaseClient().rpc(
    "is_books_private_payroll_object",
    { p_org_id: orgId, p_path: path },
  );
  if (r.error || typeof r.data !== "boolean")
    throw new Error("Document privacy could not be verified");
  return r.data;
}
