import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { SignaturesHubClient } from "@/components/esign/signatures-hub-client"
const row = {
  envelope_id: "envelope", document_id: "document", document_title: "Refreshed signature", document_type: "agreement", document_status: "sent", document_metadata: {},
  project_id: "project", project_name: "Fixture project", envelope_status: "sent", created_at: "2026-10-01T12:00:00Z",
  signer_summary: { total: 1, signed: 0, viewed: 0, pending: 1 }, next_pending_emails: [], recipient_names: [], next_pending_names: [], recipient_statuses: [], activity: [],
  queue_flags: { waiting_on_client: true, executed_this_week: false, expiring_soon: false },
}
const empty = { rows: [], summary: { total: 0, waiting_on_client: 0, executed_this_week: 0, expiring_soon: 0 }, generated_at: "2026-10-01T12:00:00Z" }
function Fixture() {
  const [data, setData] = useState(empty)
  useEffect(() => { window.signatureFixture = {
    resolveRead: (index, title) => window.signatureReads[index].resolve({ ...empty, rows: [{ ...row, document_title: title }] }),
    refresh: () => setData({ ...empty, rows: [row], summary: { ...empty.summary, total: 1, waiting_on_client: 1 } }),
    empty: () => setData({ ...empty }),
  } }, [])
  return <SignaturesHubClient initialData={data} scope="org" projectsForNewEnvelope={[]} />
}
createRoot(document.getElementById("root")).render(<Fixture />)
