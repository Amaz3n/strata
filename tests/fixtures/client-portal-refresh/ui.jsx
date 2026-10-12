import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { PunchListPortalClient } from "@/app/p/[token]/punch-list/punch-list-client"
import { WarrantyPortalClient } from "@/app/p/[token]/warranty/warranty-client"
import { DecisionsPortalClient } from "@/app/p/[token]/decisions/decisions-client"

import { SelectionsPortalClient } from "@/app/p/[token]/selections/selections-client"

const selectionOption = { id: "finish", name: "Fixture finish", price_type: "included", price_cents: 0 }
const selectionData = {
  selections: [{ id: "selection", category_id: "finishes", group_id: "group", status: "pending", selected_option_id: null, group: { id: "group", name: "Fixture selections", status: "open", cutoff_date: null } }],
  categories: [{ id: "finishes", name: "Finishes" }],
  optionsByCategory: { finishes: [selectionOption] },
  packages: [],
  configuration: { success: true, data: { violations: [], fixes: [] } },
}
const original = {
  selectionData,
  punch: [{ id: "punch", title: "Original punch", status: "open" }],
  requests: [{ id: "request", title: "Original warranty", status: "open", priority: "normal" }],
  visits: [{ id: "visit", visit_number: 1, status: "scheduled", window_start: "2026-10-04T09:00:00Z", window_end: "2026-10-04T10:00:00Z", assigned_company_name: "Original trade" }],
  decisions: [{ id: "decision", title: "Original decision", description: "Choose a fixture option", status: "pending", options: [{ id: "option", label: "Fixture option" }] }],
}
function Fixture() {
  const [mode, setMode] = useState("punch"), [token, setToken] = useState("portal-a"), [data, setData] = useState(original)
  useEffect(() => { window.portalFixture = {
    show: setMode,
    showSecondPunch: () => setData(data => ({ ...data, punch: [...original.punch, { id: "second-punch", title: "Second punch", status: "open" }] })),
    refresh: () => setData({
      selectionData: { ...selectionData, selections: selectionData.selections.map(row => ({ ...row, status: "confirmed", selected_option_id: selectionOption.id, selected_option: selectionOption })) },
      punch: original.punch.map(row => ({ ...row, title: "Refreshed punch" })),
      requests: original.requests.map(row => ({ ...row, title: "Refreshed warranty" })),
      visits: original.visits.map(row => ({ ...row, assigned_company_name: "Refreshed trade" })),
      decisions: original.decisions.map(row => ({ ...row, title: "Refreshed decision" })),
    }),
    empty: () => setData({ selectionData: { ...selectionData, selections: [] }, punch: [], requests: [], visits: [], decisions: [] }),
    lockSelections: () => setData(data => ({ ...data, selectionData: { ...data.selectionData, selections: data.selectionData.selections.map(row => ({ ...row, locked: true })) } })),
    replaceOptions: () => setData(data => ({ ...data, decisions: data.decisions.map(row => ({ ...row, options: [{ id: "replacement", label: "Updated option" }] })) })),
    approveElsewhere: () => setData(data => ({ ...data, decisions: data.decisions.map(row => ({ ...row, status: "approved" })) })),
    switchPortal: () => { setToken("portal-b"); setData(original) },
  } }, [])
  return mode === "punch" ? <PunchListPortalClient token={token} items={data.punch} />
    : mode === "warranty" ? <WarrantyPortalClient token={token} requests={data.requests} visits={data.visits} coverage={null} />
    : mode === "selections" ? <SelectionsPortalClient token={token} data={data.selectionData} />
    : <DecisionsPortalClient token={token} decisions={data.decisions} />
}
createRoot(document.getElementById("root")).render(<Fixture />)
