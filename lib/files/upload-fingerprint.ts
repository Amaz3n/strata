import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex } from "@noble/hashes/utils"

/** One sequential pass, bounded to 4 MiB, preserving ordinary SHA-256 deduplication. */
export async function hashDocumentUpload(file: Blob, signal?: AbortSignal, onProgress?: (loaded: number) => void) {
  const hash = sha256.create()
  let chain: Uint8Array = new Uint8Array(32)
  try {
    for (let offset = 0; offset < file.size; offset += 4 * 1024 * 1024) {
      signal?.throwIfAborted()
      const chunk = new Uint8Array(await file.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer())
      hash.update(chunk)
      chain = sha256.create().update(chain).update(chunk).digest()
      onProgress?.(Math.min(file.size, offset + chunk.byteLength))
      // Yield between chunks so cancellation and the progress UI stay responsive.
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    signal?.throwIfAborted()
    return { checksum: bytesToHex(hash.digest()), fingerprint: `sha256-chain-v1:${file.size}:${bytesToHex(chain)}` }
  } finally {
    hash.destroy()
  }
}
