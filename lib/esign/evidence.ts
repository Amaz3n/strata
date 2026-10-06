import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto"

export type EvidenceJson = null | boolean | number | string | EvidenceJson[] | { [key: string]: EvidenceJson }
export interface ESignEvidenceManifest {
  version: "arc-esign-evidence-v1"
  algorithm: "Ed25519"
  key_id: string
  public_key_pem: string
  payload: EvidenceJson
  signature: string
}

/** Deterministic JSON. Reject unsupported values instead of silently changing signed content. */
export function canonicalEvidenceJson(value: EvidenceJson): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalEvidenceJson).join(",")}]`
  if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalEvidenceJson(value[key])}`).join(",")}}`
  }
  throw new Error("Evidence must contain only finite JSON values.")
}

function signedContent(manifest: Omit<ESignEvidenceManifest, "signature" | "public_key_pem">) {
  return Buffer.from(canonicalEvidenceJson(manifest as unknown as EvidenceJson), "utf8")
}

/**
 * A portable application signature, not a qualified PDF seal or trusted timestamp.
 * Keep the trust anchor separately: an embedded public key alone proves no issuer identity.
 */
export function createESignEvidenceManifest(
  payload: EvidenceJson,
  privateKeyPem = process.env.ESIGN_EVIDENCE_PRIVATE_KEY_PEM,
): ESignEvidenceManifest | null {
  if (!privateKeyPem) return null
  const key = createPrivateKey(privateKeyPem.replace(/\\n/g, "\n"))
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Evidence signing requires an Ed25519 private key.")
  const publicKey = createPublicKey(key)
  const public_key_pem = publicKey.export({ format: "pem", type: "spki" }).toString()
  const key_id = createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex")
  const unsigned = { version: "arc-esign-evidence-v1" as const, algorithm: "Ed25519" as const, key_id, payload }
  return { ...unsigned, public_key_pem, signature: sign(null, signedContent(unsigned), key).toString("base64") }
}

export function verifyESignEvidenceManifest(manifest: ESignEvidenceManifest, trustedPublicKeyPem: string): boolean {
  try {
    if (manifest.version !== "arc-esign-evidence-v1" || manifest.algorithm !== "Ed25519") return false
    const publicKey = createPublicKey(trustedPublicKeyPem)
    if (publicKey.asymmetricKeyType !== "ed25519") return false
    if (!publicKey.export({ format: "der", type: "spki" }).equals(createPublicKey(manifest.public_key_pem).export({ format: "der", type: "spki" }))) return false
    const keyId = createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex")
    if (manifest.key_id !== keyId || !/^[A-Za-z0-9+/]{86}==$/.test(manifest.signature)) return false
    const unsigned = { version: manifest.version, algorithm: manifest.algorithm, key_id: manifest.key_id, payload: manifest.payload }
    return verify(null, signedContent(unsigned), publicKey, Buffer.from(manifest.signature, "base64"))
  } catch {
    return false
  }
}
