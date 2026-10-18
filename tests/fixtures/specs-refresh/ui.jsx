import { createRoot } from "react-dom/client"
import { useEffect, useState } from "react"
import { SpecsRegisterClient } from "@/components/specs/specs-register-client"

const old = { id: "old", file_id: "old-file", status: "complete", created_at: "2026-10-01" }
const active = { id: "active", file_id: "active-file", status: "processing", created_at: "2026-10-01" }
const section = { id: "section", project_id: "project", division: "01", section_number: "01 00 00", title: "Original section" }
function Fixture() {
  const [source, setSource] = useState({ project: "project", uploads: [old, active], sections: [section] })
  useEffect(() => {
    window.specsFixture = {
      completed: [old, { ...active, status: "complete" }],
      processing: [old, active],
      fresh: () => setSource({ project: "project", uploads: [old, { ...active, status: "complete" }], sections: [{ ...section, title: "Updated section" }] }),
      switchProject: () => setSource({ project: "other", uploads: [], sections: [] }),
    }
  }, [])
  return <SpecsRegisterClient key={source.project} projectId={source.project} initialUploads={source.uploads} initialSections={source.sections} canWrite={false} />
}
createRoot(document.getElementById("root")).render(<Fixture />)
