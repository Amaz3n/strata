import "server-only"
import type { OrgServiceContext } from "@/lib/services/context"

/** PostgreSQL bigint travels as a string; never round revision evidence. */
export async function readAgreementCatalogRevision(context: OrgServiceContext): Promise<string> {
  const { data, error } = await context.supabase.from("agreement_catalog_revisions").select("revision")
    .eq("org_id", context.orgId).maybeSingle()
  if (error || !data) throw new Error("Agreement catalog revision could not be verified")
  const value = data.revision
  const revision = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : ""
  if (!/^[1-9][0-9]{0,18}$/.test(revision) || BigInt(revision) > BigInt("9223372036854775807")) throw new Error("Agreement catalog revision is invalid")
  return revision
}
