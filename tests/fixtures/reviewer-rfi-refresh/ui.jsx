import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { ReviewerRfisTab } from "@/app/r/[token]/reviewer-rfis-tab"
const original = [{ id: "first", rfi_number: 1, subject: "First RFI", question: "First question", status: "open" }, { id: "second", rfi_number: 2, subject: "Second RFI", question: "Second question", status: "open" }]
function Fixture() {
  const [rows, setRows] = useState(original), [token, setToken] = useState("reviewer-a")
  useEffect(() => { window.reviewerFixture = {
    refresh: () => setRows(original.map(row => ({ ...row, subject: `Updated ${row.subject}` }))),
    empty: () => setRows([]),
    switchPortal: () => { setRows(original); setToken("reviewer-b") },
    resolve: (index, body) => window.reviewerReads[index].resolve([{ id: `response-${index}`, body, response_type: "comment", created_at: "2026-10-01T12:00:00Z" }]),
  } }, [])
  return <ReviewerRfisTab token={token} rfis={rows} />
}
createRoot(document.getElementById("root")).render(<Fixture />)
