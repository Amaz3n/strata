import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { ReviewerSubmittalsTab } from "@/app/r/[token]/reviewer-submittals-tab"
const original = ["first", "second"].map((id, index) => ({ step: { id: `step-${id}` }, submittal: { id, submittal_number: index + 1, revision: 0, title: `${id} submittal` }, is_history: false }))
function Fixture() {
  const [rows, setRows] = useState(original), [token, setToken] = useState("reviewer-a")
  useEffect(() => { window.submittalFixture = {
    refresh: () => setRows(original.map(row => ({ ...row, submittal: { ...row.submittal, title: `Updated ${row.submittal.title}` } }))),
    empty: () => setRows([]),
    history: () => setRows(original.map(row => ({ ...row, is_history: true }))),
    duplicate: () => setRows([original[0], { ...original[0], step: { id: "another-step" } }]),
    switchPortal: () => { setRows(original); setToken("reviewer-b") },
    resolve: (index, description) => window.submittalReads[index].resolve([{ id: `item-${index}`, item_number: 1, description }]),
  } }, [])
  return <ReviewerSubmittalsTab token={token} initialQueue={rows} />
}
createRoot(document.getElementById("root")).render(<Fixture />)
