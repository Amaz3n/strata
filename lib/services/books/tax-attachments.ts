import "server-only"
import { createHash } from "node:crypto"
import { mkdtemp, open, rm } from "node:fs/promises"
import { createReadStream } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import type { SupabaseClient } from "@supabase/supabase-js"
import { getFilesObjectStream } from "@/lib/storage/files-storage"
import { taxAttachmentSnapshotSchema, type TaxAttachmentSnapshot } from "./tax-attachment-rules"

/** Stream original bytes; neither a live file pointer nor a metadata hash proves them. */
async function consumeTaxAttachmentBytes(service: SupabaseClient, orgId: string, input: TaxAttachmentSnapshot, write?: (bytes: Uint8Array) => Promise<void>, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const attachment = taxAttachmentSnapshotSchema.parse(input)
  if (attachment.org_id !== orgId) throw new Error("Tax attachment is outside organization")
  const object = await getFilesObjectStream({ supabase: service, orgId, path: attachment.storage_path })
  const reader = object.body.getReader(), hash = createHash("sha256")
  const abort = () => { void reader.cancel("Attachment request cancelled").catch(() => {}) }
  signal?.addEventListener("abort", abort, { once: true })
  let bytes = BigInt(0)
  try {
    if (signal?.aborted) { await reader.cancel(); signal.throwIfAborted() }
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += BigInt(chunk.value.byteLength)
      if (bytes > BigInt(attachment.size_bytes)) {
        await reader.cancel("Tax attachment size mismatch")
        throw new Error("Tax attachment size differs from frozen evidence")
      }
      hash.update(chunk.value)
      await write?.(chunk.value)
    }
    signal?.throwIfAborted()
  } catch (error) {
    await reader.cancel("Attachment verification failed").catch(() => {})
    throw error
  } finally { signal?.removeEventListener("abort", abort); reader.releaseLock() }
  if (bytes !== BigInt(attachment.size_bytes) || hash.digest("hex") !== attachment.checksum) throw new Error("Tax attachment bytes differ from frozen evidence")
}

export async function verifyTaxAttachmentBytes(service: SupabaseClient, orgId: string, input: TaxAttachmentSnapshot) {
  await consumeTaxAttachmentBytes(service, orgId, input)
}

/** Verify the same bytes delivered to the accountant, before returning any body.
 * Disk staging avoids buffering large construction documents or fetching again
 * after verification. Each request has a private file removed on end/cancel.
 */
export async function stageVerifiedTaxAttachment(service: SupabaseClient, orgId: string, input: TaxAttachmentSnapshot, signal?: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), "arc-tax-evidence-"))
  const path = join(directory, "original")
  try {
    const file = await open(path, "wx", 0o600)
    try { await consumeTaxAttachmentBytes(service, orgId, input, bytes => file.writeFile(bytes), signal) }
    finally { await file.close() }
    signal?.throwIfAborted()
    const stream = createReadStream(path)
    const abort = () => { stream.destroy(new Error("Attachment request cancelled")) }
    signal?.addEventListener("abort", abort, { once: true })
    stream.once("close", () => {
      signal?.removeEventListener("abort", abort)
      void rm(directory, { recursive: true, force: true }).catch(() => { console.error("Could not remove temporary tax attachment") })
    })
    return Readable.toWeb(stream) as ReadableStream<Uint8Array>
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
