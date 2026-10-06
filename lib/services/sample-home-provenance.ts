import "server-only"

import { z } from "zod"
import { requireAnyPlatformPermission } from "@/lib/services/platform-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const inputSchema = z.object({
  orgId: z.string().uuid(),
  communityId: z.string().uuid(),
  batchId: z.string().uuid(),
  actorUserId: z.string().uuid(),
})
const uuid = z.string().uuid()
const SAMPLE_HOME_LOTS = ["12", "13", "14", "15", "16", "17"]

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Consume the original created-house receipts, never the org-wide WIP marker.
 * This is local containment; full seed/reset ownership still needs its durable
 * transaction contract. A metadata CAS prevents overwriting a changed snapshot.
 */
export async function tagSampleImportedHomes(rawInput: z.input<typeof inputSchema>) {
  const input = inputSchema.parse(rawInput)
  const actor = await requireAnyPlatformPermission(["platform.support.write"])
  if (actor.id !== input.actorUserId) throw new Error("Platform actor mismatch")
  const supabase = createServiceSupabaseClient()
  const [batchResult, communityResult] = await Promise.all([
    supabase.from("import_batches").select("id,created_by,importer,status,context,row_count,committed_count,skipped_count,error_count")
      .eq("org_id", input.orgId).eq("id", input.batchId).maybeSingle(),
    supabase.from("communities").select("id,metadata").eq("org_id", input.orgId).eq("id", input.communityId).maybeSingle(),
  ])
  const batch = batchResult.data
  if (batchResult.error || communityResult.error || !batch || !communityResult.data ||
    batch.created_by !== actor.id || batch.importer !== "open_wip" || batch.status !== "committed" ||
    !object(batch.context) || batch.context.is_sample !== true || batch.context.file_kind !== "houses" ||
    batch.row_count !== SAMPLE_HOME_LOTS.length || batch.committed_count !== SAMPLE_HOME_LOTS.length ||
    batch.skipped_count !== 0 || batch.error_count !== 0 || communityResult.data.metadata?.is_sample !== true) {
    throw new Error("Sample house publication evidence is incomplete or does not match the original scope")
  }
  const { data: receipts, error: receiptError } = await supabase.from("import_rows")
    .select("id,row_number,status,action,target_entity_type,target_entity_id,parsed")
    .eq("org_id", input.orgId).eq("batch_id", input.batchId).order("row_number").limit(SAMPLE_HOME_LOTS.length + 1)
  if (receiptError || !Array.isArray(receipts) || receipts.length !== SAMPLE_HOME_LOTS.length ||
    receipts.some(row => !uuid.safeParse(row.id).success || !uuid.safeParse(row.target_entity_id).success ||
      row.status !== "committed" || row.action !== "created" || row.target_entity_type !== "open_wip" ||
      !object(row.parsed) || row.parsed.community_id !== input.communityId) ||
    new Set(receipts.map(row => row.id)).size !== receipts.length ||
    new Set(receipts.map(row => row.target_entity_id)).size !== receipts.length ||
    new Set(receipts.map(row => row.row_number)).size !== receipts.length ||
    [...receipts.map(row => String(row.parsed.lot_number)).sort()].join(",") !== SAMPLE_HOME_LOTS.join(",")) {
    throw new Error("Sample house receipts are incomplete or do not match the original scope")
  }
  const ids = receipts.map(row => uuid.parse(row.target_entity_id))
  const [projectsResult, lotsResult] = await Promise.all([
    supabase.from("projects").select("id,metadata").eq("org_id", input.orgId).in("id", ids),
    supabase.from("lots").select("id,project_id,lot_number").eq("org_id", input.orgId)
      .eq("community_id", input.communityId).in("project_id", ids),
  ])
  const projects = projectsResult.data
  const lots = lotsResult.data
  if (projectsResult.error || lotsResult.error || !Array.isArray(projects) || projects.length !== ids.length ||
    !Array.isArray(lots) || lots.length !== ids.length || new Set(projects.map(row => row.id)).size !== ids.length ||
    new Set(lots.map(row => row.project_id)).size !== ids.length) {
    throw new Error("Sample house identity evidence is incomplete")
  }
  const byId = new Map(projects.map(row => [row.id, row]))
  for (const receipt of receipts) {
    const project = byId.get(receipt.target_entity_id)
    const metadata = project?.metadata
    const lot = lots.find(row => row.project_id === receipt.target_entity_id)
    if (!object(metadata) || metadata.imported_open_wip !== true || !object(metadata.wip_cutover) ||
      metadata.wip_cutover.batch_id !== input.batchId || metadata.wip_cutover.row_id !== receipt.id ||
      !lot || String(lot.lot_number) !== String(receipt.parsed.lot_number) ||
      (metadata.is_sample === true && metadata.sample_community_id !== input.communityId)) {
      throw new Error("Sample house source evidence does not match its original receipt")
    }
  }
  // Validate the entire selected set before any write. Retain every existing
  // source field; a changed metadata body produces no updated row and stops.
  for (const id of [...ids].sort()) {
    const metadata = byId.get(id)?.metadata
    if (!object(metadata)) throw new Error("Sample house metadata is no longer available")
    const { data, error } = await supabase.from("projects").update({ metadata: {
      ...metadata, is_sample: true, sample_community_id: input.communityId, sample_import_batch_id: input.batchId,
    } }).eq("org_id", input.orgId).eq("id", id).eq("metadata", JSON.stringify(metadata)).select("id").maybeSingle()
    if (error || !data || data.id !== id) {
      throw new Error("Sample house metadata changed; inspect the original sample batch before retrying")
    }
  }
  return { tagged: ids.length, batchId: input.batchId }
}
