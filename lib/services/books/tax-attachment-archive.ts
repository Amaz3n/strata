import { booksDigest } from "./hash"
import { taxAttachmentSnapshotSchema } from "./tax-attachment-rules"

export type ArchivedTaxAttachment = { id: string; storagePath: string; sizeBytes: number; checksum: string; currentFileId: string | null }
/** One original object per path/digest; every historical workpaper keeps its own identity. */
export function historicalDocumentInventory(tables: Record<string, Record<string, unknown>[]>, orgId: string): ArchivedTaxAttachment[] {
  const inventory = new Map<string, ArchivedTaxAttachment>(), paths = new Map<string,string>()
  const filesByPath = new Map<string, Record<string, unknown>[]>()
  for (const file of tables.files ?? []) {
    const key = String(file.storage_path), rows = filesByPath.get(key) ?? []
    rows.push(file); filesByPath.set(key, rows)
  }
  function add(proof: ReturnType<typeof taxAttachmentSnapshotSchema.parse>) {
      const identity = { storagePath: proof.storage_path, sizeBytes: proof.size_bytes, checksum: proof.checksum }
      const id = booksDigest(identity)
      if (paths.has(identity.storagePath) && paths.get(identity.storagePath) !== id) throw new Error("Conflicting historical document bytes at the same storage path")
      paths.set(identity.storagePath,id)
      const current = filesByPath.get(proof.storage_path) ?? []
      if (current.some(file => file.checksum !== proof.checksum || Number(file.size_bytes) !== proof.size_bytes)) throw new Error("Current and historical document bytes conflict at the same storage path")
      const currentFileId = current.map(file => String(file.id)).sort()[0] ?? null
      inventory.set(id,{ id, ...identity, currentFileId })
  }
  for (const row of tables.doc_versions ?? []) {
    if (row.org_id !== orgId) throw new Error("Document version is outside organization")
    const proof = taxAttachmentSnapshotSchema.parse({version:1,org_id:orgId,file_id:row.file_id,document_version_id:row.id,storage_path:row.storage_path,file_name:row.file_name,mime_type:row.mime_type ?? null,size_bytes:row.size_bytes == null ? undefined : Number(row.size_bytes),checksum:row.checksum})
    add(proof)
  }
  for (const batch of tables.books_tax_adjustment_workpapers ?? []) {
    if (!Array.isArray(batch.lines)) throw new Error("Invalid tax adjustment evidence")
    for (const line of batch.lines) {
      if (!line.evidence_snapshot) continue
      const proof = taxAttachmentSnapshotSchema.parse(line.evidence_snapshot)
      if (proof.org_id !== orgId || proof.file_id !== line.evidence_file_id) throw new Error("Frozen tax attachment organization or file differs")
      add(proof)
    }
  }
  for (const payroll of tables.books_payroll_imports ?? []) {
    const proof = taxAttachmentSnapshotSchema.parse(payroll.source_proof)
    if (payroll.org_id !== orgId || proof.org_id !== orgId || !proof.document_version_id || proof.checksum !== payroll.source_checksum) throw new Error("Payroll original source identity differs")
    add(proof)
  }
  for (const correction of tables.books_payroll_correction_sources ?? []) {
    const proof=taxAttachmentSnapshotSchema.parse(correction.source_proof)
    if(correction.org_id!==orgId||proof.org_id!==orgId||!proof.document_version_id||proof.checksum!==(correction.run as Record<string,unknown>)?.source_checksum)throw new Error("Correction original document differs")
    add(proof)
  }
  for (const review of tables.books_payroll_payment_reviews ?? []) {
    if (review.org_id !== orgId || !Array.isArray((review.evidence as Record<string, unknown> | undefined)?.supporting_documents)) throw new Error("Invalid payroll payment document inventory")
    for (const input of (review.evidence as { supporting_documents: unknown[] }).supporting_documents) {
      const proof = taxAttachmentSnapshotSchema.parse(input)
      if (proof.org_id !== orgId || !proof.document_version_id) throw new Error("Payroll payment original version is outside organization")
      add(proof)
    }
  }
  return [...inventory.values()].sort((a,b) => a.id.localeCompare(b.id))
}
