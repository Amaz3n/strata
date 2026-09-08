import { booksDigest } from "@/lib/services/books/hash"

/** A revision's identity includes its effective date and position in source history. */
export function factTransitionIdentity(input: {
  orgId: string; sourceType: string; sourceId: string; accountingDate: string; payload: unknown
  previous: { payload_hash: string; source_version: number; accounting_date: string } | null
}) {
  const datedHash = booksDigest({ accountingDate: input.accountingDate, payload: input.payload })
  // Preserve legacy facts when their economics AND effective date have not changed.
  // Deploying the hashing fix must not reverse every already-correct historical entry.
  const unchanged = input.previous?.accounting_date === input.accountingDate
    && [datedHash, booksDigest(input.payload)].includes(input.previous.payload_hash)
  const sourceVersion = unchanged ? input.previous!.source_version : (input.previous?.source_version ?? 0) + 1
  const payloadHash = unchanged ? input.previous!.payload_hash : datedHash
  return { sourceVersion, payloadHash, idempotencyKey: booksDigest({
    orgId: input.orgId, sourceType: input.sourceType, sourceId: input.sourceId, sourceVersion, payloadHash,
  }) }
}
