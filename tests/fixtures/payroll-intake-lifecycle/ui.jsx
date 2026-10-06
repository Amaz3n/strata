import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { PayrollRegisterIntake } from "@/components/time/payroll-register-intake"
import { payrollRegisterFields } from "@/lib/services/books/payroll-register-fields"

const register = { provider: "Fixture provider", provider_run_id: "Run 1", period_start: "2026-10-01", period_end: "2026-10-02", pay_date: "2026-10-04", employees: [{ employee_reference: "employee-one" }], controls: { gross_cents: 100 } }
const inspection = { document: { fileId: "file", documentVersionId: "version", fileName: "provider.csv", sizeBytes: 10 }, headers: [...payrollRegisterFields], register }
const workers = { workers: [{ id: "worker", name: "Original worker", email: "fixture@example.com", statuses: ["active"] }], nextCursor: "older" }
const labor = { register, labor: [{ id: "labor", worker_id: "worker", incurred_on: "2026-10-02", account_code: "5000", gross_cents: 100, estimated_burden_cents: 0 }], ownedNativeLabor: [] }

function Fixture() {
  const [mounted, setMounted] = useState(true)
  const [projectId, setProjectId] = useState("project-one")
  useEffect(() => {
    window.intakeFixture = { unmount: () => setMounted(false), changeProject: setProjectId, inspection, workers, labor }
    const originalFetch = window.fetch
    window.fetch = (url, options) => {
      if (new URL(url, window.location.href).pathname !== "/private-upload") return originalFetch(url, options)
      return new Promise((resolve, reject) => {
        const upload = { options, aborted: false, resolve: status => resolve({ ok: status >= 200 && status < 300, status }), reject }
        ;(window.intakeUploads ??= []).push(upload)
        options?.signal?.addEventListener("abort", () => {
          upload.aborted = true
          reject(new DOMException("Upload aborted", "AbortError"))
        }, { once: true })
      })
    }
    return () => { window.fetch = originalFetch }
  }, [])
  return mounted ? <PayrollRegisterIntake key={projectId} projectId={projectId} /> : <p>Intake removed</p>
}
createRoot(document.getElementById("root")).render(<Fixture />)
