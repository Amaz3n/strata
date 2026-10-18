import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { SubmittalDetailSheet } from "@/components/submittals/submittal-detail-sheet"
const initial = { id: "submittal", project_id: "project", title: "Fixture submittal", submittal_number: 1, revision: 0, status: "in_review" }
function Fixture() {
  const [submittal, setSubmittal] = useState(initial)
  const [open, setOpen] = useState(true)
  useEffect(() => { window.submittalFixture = { refresh: () => setSubmittal({ ...initial }) } }, [])
  return <SubmittalDetailSheet key={submittal.id} submittal={submittal} open={open} onOpenChange={setOpen} />
}
createRoot(document.getElementById("root")).render(<Fixture />)
