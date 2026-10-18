import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { EstimatesClient } from "@/components/estimates/estimates-client"
const original = [{ id: "estimate", title: "Fixture estimate", recipient_name: "Fixture recipient", status: "draft", total_cents: 10000 }]
function Fixture() {
  const [rows, setRows] = useState(original)
  useEffect(() => { window.estimateFixture = {
    refresh: () => setRows(original.map(row => ({ ...row, title: "Fixture refreshed", status: "executed", total_cents: 20000 }))),
    empty: () => setRows([]),
  } }, [])
  return <EstimatesClient estimates={rows} contacts={[]} costCodes={[]} />
}
createRoot(document.getElementById("root")).render(<Fixture />)
