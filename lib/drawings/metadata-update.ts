import type { SupabaseClient } from "@supabase/supabase-js"

/** Compare-and-swap: parallel render and label jobs must not lose each other's keys. */
export async function updateDrawingMetadata(
  supabase: SupabaseClient, orgId: string, versionId: string,
  merge: (current: Record<string, any>) => Record<string, any>,
) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { data: row, error } = await supabase.from("drawing_sheet_versions")
      .select("extracted_metadata").eq("org_id", orgId).eq("id", versionId).maybeSingle()
    if (error) throw new Error(`Unable to read drawing metadata: ${error.message}`)
    if (!row) return
    const result = await supabase.rpc("compare_exchange_drawing_metadata", {
      p_org_id: orgId, p_version_id: versionId,
      p_expected: row.extracted_metadata, p_next: merge(row.extracted_metadata ?? {}),
    })
    if (result.error) throw new Error(`Unable to save drawing metadata: ${result.error.message}`)
    if (result.data) return
  }
  throw new Error("Drawing metadata changed repeatedly; retry the update")
}
