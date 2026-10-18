import { createRoot } from "react-dom/client"
import { useState } from "react"
import { RfiForm } from "@/components/rfis/rfi-form"
import { InspectionForm } from "@/components/inspections/inspection-form"
import { SelectionForm } from "@/components/selections/selection-form"

function Fixture() {
  const [open, setOpen] = useState(true)
  const common = { open, onOpenChange: setOpen, onSubmit: async () => {} }
  const project = { id: "project", name: "Fixture project" }
  const kind = new URLSearchParams(location.search).get("form")
  return <>
    <button onClick={() => setOpen(true)}>Reopen fixture</button>
    {kind === "rfi" ? <RfiForm {...common} projects={[project]} companies={[
      { id: "alpha", name: "Alpha Plumbing", company_type: "subcontractor" },
      { id: "beta", name: "Beta Electric", company_type: "subcontractor" },
    ]} contacts={[
      { id: "alice", full_name: "Alice", email: "alice@example.test", contact_type: "external", primary_company_id: "alpha" },
      { id: "bob", full_name: "Bob", email: "bob@example.test", contact_type: "external", primary_company_id: "beta" },
    ]} /> : kind === "inspection" ? <InspectionForm {...common} projectId="project" locations={[]} canManageLocations={false} templates={[
      { id: "rough", name: "Rough inspection", kind: "quality" },
    ]} /> : <SelectionForm {...common} projects={[project]} categories={[{ id: "floor", name: "Flooring" }]} />}
  </>
}
createRoot(document.getElementById("root")).render(<Fixture />)
