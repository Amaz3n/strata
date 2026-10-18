import { createHash } from "node:crypto"

/** Versioned, domain-separated UUIDs; package identity survives worker retries. */
export function startsConfirmationId(orgId: string, packageId: string, kind: "event" | "notification", userId?: string) {
  if (!orgId || !packageId || (kind === "notification" && !userId)) throw new Error("Starts confirmation identity is missing its scope")
  const hex = createHash("sha256").update(JSON.stringify(["arc.starts.confirmation.v1", orgId, packageId, kind, userId ?? null])).digest("hex")
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
}
