import "server-only"

import { bidPackageTermsInputSchema } from "@/lib/validation/bids"
import { recordAudit } from "@/lib/services/audit"
import { getBidPackage } from "@/lib/services/bids"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requireAnyPermission } from "@/lib/services/permissions"

/** What a request says beyond its lines: the sheets it is priced from and a site walk. */
export interface BidPackageTerms {
  site_walk_at: string | null
  sheet_ids: string[]
}

const EMPTY_TERMS: BidPackageTerms = { site_walk_at: null, sheet_ids: [] }

// Until 20261022100000_bid_package_sheets_and_terms is applied the columns and table do not exist.
function termsSchemaMissing(error: { code?: string } | null) {
  return !!error && ["42703", "42P01", "PGRST204", "PGRST205"].includes(error.code ?? "")
}

/** Terms for packages the caller already loaded (and so may see), keyed by package. */
export async function listBidPackageTerms(packageIds: string[], orgId?: string) {
  const terms = new Map<string, BidPackageTerms>(packageIds.map((id) => [id, { ...EMPTY_TERMS, sheet_ids: [] }]))
  if (!packageIds.length) return { terms, available: true }
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const [packages, sheets] = await Promise.all([
    supabase.from("bid_packages").select("id, site_walk_at").eq("org_id", resolvedOrgId).in("id", packageIds),
    supabase.from("bid_package_sheets").select("bid_package_id, drawing_sheet_id").eq("org_id", resolvedOrgId).in("bid_package_id", packageIds),
  ])
  if (termsSchemaMissing(packages.error) || termsSchemaMissing(sheets.error)) return { terms, available: false }
  if (packages.error) throw new Error(`Unable to load bid request terms: ${packages.error.message}`)
  if (sheets.error) throw new Error(`Unable to load bid request sheets: ${sheets.error.message}`)
  for (const row of packages.data ?? []) {
    const entry = terms.get(row.id)
    if (entry) entry.site_walk_at = row.site_walk_at ?? null
  }
  for (const row of sheets.data ?? []) terms.get(row.bid_package_id)?.sheet_ids.push(row.drawing_sheet_id)
  return { terms, available: true }
}

/** Replaces a request's sheets and site walk. Sheets must belong to the request's project. */
export async function saveBidPackageTerms({ bidPackageId, input, orgId }: { bidPackageId: string; input: unknown; orgId?: string }) {
  const parsed = bidPackageTermsInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })
  const pkg = await getBidPackage(bidPackageId, resolvedOrgId)
  if (["closed", "awarded", "cancelled"].includes(pkg.status)) throw new Error("This request is closed to changes.")
  const sheetIds = [...new Set(parsed.sheet_ids)]
  if (sheetIds.length) {
    if (!pkg.project_id) throw new Error("Upload plans to the deal before choosing sheets.")
    const { data, error } = await supabase
      .from("drawing_sheets")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", pkg.project_id)
      .in("id", sheetIds)
    if (error) throw new Error(`Unable to check the sheets: ${error.message}`)
    if ((data ?? []).length !== sheetIds.length) throw new Error("Choose sheets from this deal's plans only.")
  }

  const { data: before, error: beforeError } = await supabase
    .from("bid_package_sheets")
    .select("drawing_sheet_id")
    .eq("org_id", resolvedOrgId)
    .eq("bid_package_id", bidPackageId)
  if (termsSchemaMissing(beforeError)) throw new Error("Sheets and site walks need the pending database update.")
  if (beforeError) throw new Error(`Unable to load the request's sheets: ${beforeError.message}`)
  const current = (before ?? []).map((row) => row.drawing_sheet_id as string)
  const removed = current.filter((id) => !sheetIds.includes(id))
  const added = sheetIds.filter((id) => !current.includes(id))

  const { error: updateError } = await supabase
    .from("bid_packages")
    .update({ site_walk_at: parsed.site_walk_at, updated_at: new Date().toISOString() })
    .eq("org_id", resolvedOrgId)
    .eq("id", bidPackageId)
  if (updateError) throw new Error(`Unable to save the request: ${updateError.message}`)
  if (removed.length) {
    const { error } = await supabase
      .from("bid_package_sheets")
      .delete()
      .eq("org_id", resolvedOrgId)
      .eq("bid_package_id", bidPackageId)
      .in("drawing_sheet_id", removed)
    if (error) throw new Error(`Unable to remove sheets: ${error.message}`)
  }
  if (added.length) {
    const { error } = await supabase
      .from("bid_package_sheets")
      .insert(added.map((id) => ({ org_id: resolvedOrgId, bid_package_id: bidPackageId, drawing_sheet_id: id })))
    if (error) throw new Error(`Unable to add sheets: ${error.message}`)
  }

  const changes = { site_walk_at: parsed.site_walk_at, sheets_added: added.length, sheets_removed: removed.length }
  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "bid_package_updated", entityType: "bid_package", entityId: bidPackageId, payload: changes }),
    recordAudit({
      orgId: resolvedOrgId,
      actorId: userId,
      action: "update",
      entityType: "bid_package",
      entityId: bidPackageId,
      before: { sheet_ids: current },
      after: { ...changes, sheet_ids: sheetIds },
    }),
  ])
  return { site_walk_at: parsed.site_walk_at, sheet_ids: sheetIds } satisfies BidPackageTerms
}
