require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { createFakeSupabase } = require("./support/fake-supabase")
const { updateDrawingMetadata } = require("../lib/drawings/metadata-update")

/** `compare_exchange_drawing_metadata`: write only if the row still holds what the caller read. */
function compareExchange({ p_org_id, p_version_id, p_expected, p_next }, store) {
  const row = store.drawing_sheet_versions.find((version) => version.id === p_version_id && version.org_id === p_org_id)
  if (!row || JSON.stringify(row.extracted_metadata) !== JSON.stringify(p_expected)) return { data: false, error: null }
  row.extracted_metadata = structuredClone(p_next)
  return { data: true, error: null }
}

test("parallel writers each keep their own keys", async () => {
  const supabase = createFakeSupabase(
    { drawing_sheet_versions: [{ id: "version", org_id: "org", extracted_metadata: { is_new_sheet: true } }] },
    { compare_exchange_drawing_metadata: compareExchange },
  )

  await Promise.all([
    updateDrawingMetadata(supabase, "org", "version", (current) => ({ ...current, vector_stats: { segments: 100 } })),
    updateDrawingMetadata(supabase, "org", "version", (current) => ({ ...current, proposed: { sheet_number: "A2" } })),
  ])

  assert.deepEqual(supabase.store.drawing_sheet_versions[0].extracted_metadata, {
    is_new_sheet: true,
    vector_stats: { segments: 100 },
    proposed: { sheet_number: "A2" },
  })
})
