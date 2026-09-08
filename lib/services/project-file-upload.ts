import { createHash } from "node:crypto"

export class UploadRecordInsertError extends Error {
  readonly definitive: boolean

  constructor(message: string, code?: string) {
    super(message)
    // Data/constraint/access rejections establish that the insert did not
    // commit. Connection and completion-unknown errors deliberately do not.
    this.definitive = Boolean(code && /^(22|23|42)[0-9A-Z]{3}$/.test(code))
  }
}

export function uploadRequestFingerprint(bytes: Uint8Array, attributes: Record<string, unknown>) {
  const contentHash = createHash("sha256").update(bytes).digest("hex")
  return createHash("sha256").update(JSON.stringify({ contentHash, attributes })).digest("hex")
}

/** A unique storage path per attempt is required: a losing upload may only
 * clean up its own object, never the object referenced by the winning row.
 * Ambiguous DB responses are reconciled by ID before deleting anything.
 */
export async function persistProjectUpload<T extends { storage_path: string }>(options: {
  retrySafe: boolean
  storagePath: string
  findExisting: () => Promise<T | null>
  validateExisting: (row: T) => void
  uploadObject: () => Promise<void>
  insertRecord: () => Promise<T>
  cleanupObject: () => Promise<void>
}): Promise<{ record: T; created: boolean }> {
  if (options.retrySafe) {
    const existing = await options.findExisting()
    if (existing) {
      options.validateExisting(existing)
      return { record: existing, created: false }
    }
  }
  await options.uploadObject()
  try {
    return { record: await options.insertRecord(), created: true }
  } catch (error) {
    if (options.retrySafe) {
      // If reconciliation itself fails, preserve the object: the insert may
      // have committed and its response may have been lost.
      const existing = await options.findExisting()
      if (existing) {
        if (existing.storage_path !== options.storagePath) await options.cleanupObject()
        options.validateExisting(existing)
        // Our own insert committed: this attempt has not run post-insert work
        // yet, so it still owns version/event initialization.
        return { record: existing, created: existing.storage_path === options.storagePath }
      }
    }
    if (error instanceof UploadRecordInsertError && error.definitive) await options.cleanupObject()
    throw error
  }
}
