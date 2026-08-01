import { takeBudgetSnapshot } from "@/lib/services/budgets"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { captureProjectPocSnapshot } from "@/lib/services/poc"

const PROJECT_BATCH_SIZE = 10
const DAILY_RETENTION_DAYS = 90

export interface NightlySnapshotResult {
  attempted: number
  captured: number
  failed: Array<{ project_id: string; error: string }>
  pruned: number
}

async function pruneOrgSnapshots(orgId: string, cutoff: string): Promise<number> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("budget_snapshots").select("id,snapshot_date,status")
    .eq("org_id", orgId).eq("source", "nightly").lt("snapshot_date", cutoff).limit(5000)
  if (error) throw new Error(`Failed to load snapshot retention candidates: ${error.message}`)
  const deleteIds = (data ?? [])
    .filter((row) => row.status !== "formal" && !String(row.snapshot_date).endsWith("-01"))
    .map((row) => row.id)
  if (deleteIds.length === 0) return 0
  const { error: deleteError } = await supabase.from("budget_snapshots").delete().eq("org_id", orgId).in("id", deleteIds)
  if (deleteError) throw new Error(`Failed to prune budget snapshots: ${deleteError.message}`)
  return deleteIds.length
}

export async function captureNightlyForecastSnapshots(): Promise<NightlySnapshotResult> {
  const supabase = createServiceSupabaseClient()
  const { data: projects, error } = await supabase.from("projects").select("id,org_id")
    .in("status", ["active", "planning", "on_hold"]).order("org_id").limit(5000)
  if (error) throw new Error(`Failed to load active projects: ${error.message}`)
  const rows = projects ?? []
  const result: NightlySnapshotResult = { attempted: rows.length, captured: 0, failed: [], pruned: 0 }
  for (let offset = 0; offset < rows.length; offset += PROJECT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + PROJECT_BATCH_SIZE)
    const settled = await Promise.allSettled(batch.map(async (project) => {
      const [budgetSnapshot, pocSnapshot] = await Promise.all([
        takeBudgetSnapshot(project.id, project.org_id, { source: "nightly" }),
        captureProjectPocSnapshot(project.id, project.org_id),
      ])
      return { budgetSnapshot, pocSnapshot }
    }))
    settled.forEach((entry, index) => {
      if (entry.status === "fulfilled") {
        if (entry.value.budgetSnapshot || entry.value.pocSnapshot) result.captured += 1
      } else {
        result.failed.push({ project_id: batch[index].id, error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason) })
      }
    })
  }
  const cutoff = new Date(Date.now() - DAILY_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10)
  const orgIds = Array.from(new Set(rows.map((row) => row.org_id)))
  const pruneResults = await Promise.allSettled(orgIds.map((orgId) => pruneOrgSnapshots(orgId, cutoff)))
  result.pruned = pruneResults.reduce((sum, entry) => sum + (entry.status === "fulfilled" ? entry.value : 0), 0)
  return result
}
