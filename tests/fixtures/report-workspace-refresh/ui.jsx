import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { ReportWorkspace } from "@/components/reports/report-workspace"
import { PageTitleProvider } from "@/components/layout/page-title-context"
const result = label => ({ tables: [{ key: "fixture", columns: [{ key: "name", header: "Name" }], rows: [{ key: "row", cells: { name: label } }] }] })
const params = { include: "0" }
function Fixture() {
  const [base, setBase] = useState(result("Original server row"))
  const [fingerprint, setFingerprint] = useState("original-fingerprint")
  useEffect(() => { window.reportFixture = {
    refresh: () => { setBase(result("Fresh server row")); setFingerprint("fresh-fingerprint") },
    resolve: (index, label) => window.reportReads[index].resolve({ base: result(label), fingerprint: label }),
  } }, [])
  return <ReportWorkspace definition={{ slug: "fixture", title: "Fixture report", params: [{ key: "include", kind: "toggle", label: "Include optional rows" }] }} context={{ scope: "org", scopeLabel: "Fixture org", posture: "builder" }} params={params} base={base} fingerprint={fingerprint} lenses={{ divisions: [], communities: [] }} packetReports={[]} />
}
createRoot(document.getElementById("root")).render(<PageTitleProvider><Fixture /></PageTitleProvider>)
