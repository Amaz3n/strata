import { createRoot } from "react-dom/client"
import { useEffect, useState } from "react"
import { ImportWorkspace } from "@/components/admin/import-workspace"
const batches = [
  { id: "batch-one", source_filename: "first.csv", status: "staged", row_count: 1, valid_count: 1, warning_count: 0, error_count: 0, update_existing: false },
  { id: "batch-two", source_filename: "second.csv", status: "staged", row_count: 500, valid_count: 499, warning_count: 1, error_count: 0, update_existing: false },
]
const actions = {
  previewAction: async () => ({ success: true, data: { headers: ["Name"], suggestion: { mappings: [{ target: "name", source: "Name", confidence: "high" }], unmatched_targets: [], unmapped_sources: [] } } }),
  stageAction: async input => { window.stagedImportInput = input; return { success: true, data: batches[0] } },
  patchAction: async () => ({ success: true, data: null }),
  updateExistingAction: async () => ({ success: true, data: null }),
  commitAction: async () => { throw Error("Fixture must not commit") },
  discardAction: async () => { throw Error("Fixture must not discard") },
}
function Fixture() {
  const [detail, setDetail] = useState(null)
  const [orgId, setOrgId] = useState("org-one")
  useEffect(() => {
    window.importFixture = {
      showBatch: id => {
        const batch = batches.find(batch => batch.id === id)
        const rows = Array.from({ length: batch.row_count }, (_, index) => ({ id: `${id}-row-${index}`, row_number: index + 1, parsed: { name: `Fixture row ${index + 1}` }, status: index === 1 ? "warning" : "valid", issues: [] }))
        setDetail({ batch, rows, total: rows.length })
      },
      clear: () => setDetail(null),
      changeOrg: () => setOrgId("org-two"),
    }
  }, [])
  return <ImportWorkspace {...actions} orgId={orgId} importer="contacts" label="Fixture import" description="Synthetic staging only" columns={[{ key: "name", label: "Name", required: true }]} batches={batches} detail={detail} backHref="/settings/imports" />
}
createRoot(document.getElementById("root")).render(<Fixture />)
