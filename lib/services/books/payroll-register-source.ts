import "server-only"
import { createHash } from "node:crypto"
import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getFilesObjectStream } from "@/lib/storage/files-storage"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "./access"
import { booksDigest } from "./hash"
import { payrollRunFromCsv } from "./payroll-register-csv"
import { canonicalPayrollRegisterRequest } from "./payroll-register-request"
import { payrollReconciliationFromSnapshot } from "./payroll-labor-snapshot"
import { taxAttachmentSnapshotSchema, type TaxAttachmentSnapshot } from "./tax-attachment-rules"

const MAX_REGISTER_BYTES = 16 * 1024 * 1024
const snapshotSchema = z.object({ orgId: z.string().uuid(), tables: z.record(z.array(z.record(z.unknown()))) }).passthrough()

async function verifiedRegisterText(service: ReturnType<typeof createServiceSupabaseClient>, orgId: string, proof: TaxAttachmentSnapshot) {
  if (!proof.size_bytes || proof.size_bytes > MAX_REGISTER_BYTES) throw new Error("Payroll register must contain 1 byte to 16 MiB; larger registers need the background import workflow")
  const { body } = await getFilesObjectStream({ supabase: service, orgId, path: proof.storage_path })
  const reader = body.getReader(), hash = createHash("sha256"), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > proof.size_bytes) throw new Error("Payroll register size differs from original version")
      hash.update(chunk.value); chunks.push(chunk.value.slice())
    }
    if (size !== proof.size_bytes || hash.digest("hex") !== proof.checksum) throw new Error("Payroll register bytes differ from original version")
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
  } catch (error) { await reader.cancel("Payroll register verification failed").catch(() => {}); throw error }
  finally { reader.releaseLock() }
}

/** Read one captured document version and derive provider amounts from its
 * verified bytes. Labor reconciliation and corrected-register delta planning
 * consume this shared source; approval and posting remain separate controls.
 */
export async function readVerifiedPayrollRegisterFile(input: unknown) {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.adjust", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "payroll_import", resourceId: context.orgId, logDecision: true })
  const args = canonicalPayrollRegisterRequest(input), service = createServiceSupabaseClient()
  const capture = await service.rpc("capture_books_export_snapshot", { p_org_id: context.orgId })
  if (capture.error) throw new Error(`Failed to capture payroll register evidence: ${capture.error.message}`)
  const snapshot = snapshotSchema.parse(capture.data)
  if (snapshot.orgId !== context.orgId) throw new Error("Payroll register snapshot organization mismatch")
  for (const name of ["files", "doc_versions", "projects", "cost_codes"]) {
    if (!snapshot.tables[name] || snapshot.tables[name].some(row => row.org_id !== context.orgId)) throw new Error(`Payroll register has missing or foreign ${name}`)
  }
  const file = snapshot.tables.files.find(row => row.id === args.fileId), version = snapshot.tables.doc_versions.find(row => row.id === args.documentVersionId)
  if (!file || !version || version.file_id !== file.id) throw new Error("Payroll register original version is unavailable in this organization")
  const proof = taxAttachmentSnapshotSchema.parse({ version: 1, org_id: context.orgId, file_id: file.id, document_version_id: version.id, storage_path: version.storage_path, file_name: version.file_name, mime_type: version.mime_type ?? null, size_bytes: version.size_bytes == null ? undefined : Number(version.size_bytes), checksum: version.checksum })
  const projects = new Set(snapshot.tables.projects.map(row => row.id)), codes = new Set(snapshot.tables.cost_codes.map(row => row.id))
  for (const worker of args.workers) for (const allocation of worker.allocations) {
    if (allocation.project_id && !projects.has(allocation.project_id) || allocation.cost_code_id && !codes.has(allocation.cost_code_id)) throw new Error("Payroll construction allocation is outside organization")
  }
  // Membership confirms that explicit worker mappings refer to native workers
  // of this organization. It does not infer wages from mutable labor profiles.
  const ids = [...new Set(args.workers.map(worker => worker.worker_id))]
  for (let start = 0; start < ids.length; start += 200) {
    const batch = ids.slice(start, start + 200)
    const { data, error } = await service.from("memberships").select("user_id,org_id").eq("org_id", context.orgId).in("user_id", batch).limit(1000)
    if (error || !data || data.some(row => row.org_id !== context.orgId) || batch.some(id => !data.some(row => row.user_id === id))) throw new Error("Payroll worker mapping is outside organization or unavailable")
  }
  const text = await verifiedRegisterText(service, context.orgId, proof)
  const run = payrollRunFromCsv({ text, checksum: proof.checksum, orgId: context.orgId, runId: args.runId, mapping: args.mapping, workers: args.workers })
  return { run, snapshot, providerSourceVerified: true as const, sourceProof: proof, columnMapping: args.mapping,
    sourceMappingDigest: booksDigest({ source: proof, columns: args.mapping, workers: [...run.employees].sort((a,b)=>a.worker_id.localeCompare(b.worker_id)).map(worker => ({ worker_id: worker.worker_id, employee_reference: worker.employee_reference, allocations: [...worker.allocations].map(allocation=>({...allocation,labor_evidence_ids:[...allocation.labor_evidence_ids].sort()})).sort((a,b)=>a.id.localeCompare(b.id)) })) }) }
}

/** First-run reconciliation uses native labor; correction callers consume the
 * same byte-verified register without recognizing that labor again. */
export async function previewPayrollRegisterFile(input: unknown) {
  const source = await readVerifiedPayrollRegisterFile(input)
  const result = payrollReconciliationFromSnapshot(source.run.org_id, source.run, source.snapshot)
  return {...result, providerSourceVerified:source.providerSourceVerified, sourceProof:source.sourceProof, columnMapping:source.columnMapping, sourceMappingDigest:source.sourceMappingDigest}
}
