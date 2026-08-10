/**
 * One hash for the approval-time signals, so an unchanged bill against
 * unchanged comparables is never recomputed. FNV-1a over a canonical JSON of
 * the inputs — the same scheme the line-match assessment uses.
 */
export function fnv1aHex(canonical: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}
