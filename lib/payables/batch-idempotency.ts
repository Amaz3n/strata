/**
 * One logical pay-batch submit is one idempotency key. The key is minted when
 * the dialog opens and combined with a fingerprint of what is being paid, so a
 * network retry of the same submit reaches the same payment run instead of
 * creating a second one, while a changed selection gets its own key (the server
 * rejects a key reused for different contents). `generation` moves only when a
 * run was deliberately discarded, so a fresh attempt is not handed that run back.
 */

export interface PayBatchLine {
  billId: string
  amountCents: number
}

/** Order-independent 32-bit FNV-1a over the funding source and the lines. */
export function payBatchFingerprint(fundingSourceId: string, lines: readonly PayBatchLine[]): string {
  const canonical = [fundingSourceId, ...lines.map((line) => `${line.billId}:${line.amountCents}`).sort()].join("|")
  let hash = 0x811c9dc5
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

export function payBatchIdempotencyKey(sessionId: string, fingerprint: string, generation: number): string {
  return `pay-batch:${sessionId}:${fingerprint}:${generation}`
}
