import { createHash } from "node:crypto"
import { parsePayrollDraftEvidence } from "./payroll-draft-evidence"
import { payrollRunFromCsv } from "./payroll-register-csv"
import { reconcilePayrollImport } from "./payroll-import-rules"
import { booksDigest } from "./hash"

/** v2 recovery re-derives provider money/dates from the retained original CSV,
 * rather than accepting a newly hashed, internally consistent replacement run.
 */
export function verifyPayrollArchiveSource(input: unknown, encoded: string) {
  const evidence = parsePayrollDraftEvidence(input), proof = evidence.source_proof
  if (evidence.reconciliation.evidenceVersion !== 2) throw new Error("Payroll source replay requires workflow evidence v2")
  if (!proof.size_bytes || proof.size_bytes > 16 * 1024 * 1024 || encoded.length > Math.ceil(proof.size_bytes / 3) * 4) throw new Error("Payroll archived register exceeds its supported source size")
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.toString("base64") !== encoded || bytes.length !== proof.size_bytes || createHash("sha256").update(bytes).digest("hex") !== proof.checksum) throw new Error("Payroll archived register bytes differ from original proof")
  const run = payrollRunFromCsv({ text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), checksum: proof.checksum,
    orgId: evidence.run.org_id, runId: evidence.run.id, mapping: evidence.column_mapping,
    workers: evidence.run.employees.map(worker => ({ worker_id: worker.worker_id, employee_reference: worker.employee_reference, allocations: worker.allocations })) })
  const rebuilt = reconcilePayrollImport(run, evidence.labor_evidence, evidence.reconciliation.postingAccounts as Parameters<typeof reconcilePayrollImport>[2])
  if (booksDigest(rebuilt.run) !== booksDigest(evidence.run)) throw new Error("Payroll archived financial amounts or run dates differ from original register")
  return true
}
