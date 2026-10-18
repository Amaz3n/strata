import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { RfiDetailSheet } from "@/components/rfis/rfi-detail-sheet"
const initial = { id: "rfi", project_id: "project", subject: "Original RFI", rfi_number: 1, status: "answered", question: "Fixture question" }
function Fixture() {
  const [rfi, setRfi] = useState(initial)
  const [open, setOpen] = useState(true)
  useEffect(() => { window.rfiFixture = { refresh: () => setRfi({ ...initial, subject: "Refreshed RFI" }), selectSecond: () => setRfi({ ...initial, id: "second", subject: "Second RFI" }) } }, [])
  return <RfiDetailSheet key={rfi.id} rfi={rfi} open={open} onOpenChange={setOpen} />
}
createRoot(document.getElementById("root")).render(<Fixture />)
