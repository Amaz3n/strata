import { createRoot } from "react-dom/client"
import { useEffect, useState } from "react"
import { CertifiedPayrollClient } from "@/app/(app)/projects/[id]/time/certified-payroll/certified-payroll-client"

const first = {
  id: "report-one", payroll_number: 1, week_ending: "2026-10-02", status: "draft", is_no_work: false,
  lines: [{ id: "line-one", worker: { display_name: "Fixture worker" }, classification_id: "class-one", day_hours: {}, gross_this_project_cents: 10000, gross_all_projects_cents: 10000, deductions: { other: 500 }, net_pay_cents: 9500 }],
}
const second = { id: "report-two", payroll_number: 2, week_ending: "2026-10-09", status: "draft", is_no_work: true, lines: [] }
function Fixture() {
  const [selected, setSelected] = useState(first)
  useEffect(() => {
    window.payrollFixture = {
      replaceReport: setSelected,
      refreshMoney: () => setSelected({ ...first, lines: [{ ...first.lines[0], gross_all_projects_cents: 15000 }] }),
      second: () => setSelected(second),
      finalize: () => setSelected({ ...first, status: "finalized" }),
    }
  }, [])
  return <CertifiedPayrollClient projectId="project-one" determinations={[]} workers={[]} classifications={[{ id: "class-one", classification: "Electrician" }]} reports={[first, second]} initialSelected={selected} />
}
createRoot(document.getElementById("root")).render(<Fixture />)
