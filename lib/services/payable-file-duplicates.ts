import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

/** A leftover document is not a duplicate bill. Only another payable counts. */
export async function payableFileDuplicateWarning(db: SupabaseClient, orgId: string, checksum: string | undefined, billId?: string): Promise<string | null> {
  if (!checksum) return null
  let query = db.from("vendor_bills")
    .select("id,invoice:files!vendor_bills_file_id_fkey!inner(checksum)")
    .eq("org_id", orgId).eq("invoice.checksum", checksum).limit(1)
  if (billId) query = query.neq("id", billId)
  const { data, error } = await query
  if (error) {
    console.warn("Invoice duplicate check unavailable", error.message)
    return "Duplicate check unavailable. Review this bill before submitting."
  }
  return data?.length ? "May be a duplicate: the same PDF is attached to another bill." : null
}
