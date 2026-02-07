import { createHmac, timingSafeEqual } from "crypto"

function requireDocumentSigningSecret() {
  const secret = process.env.DOCUMENT_SIGNING_SECRET
  if (!secret) {
    throw new Error("Missing DOCUMENT_SIGNING_SECRET environment variable")
  }
  return secret
}

function signPayload(payload: string) {
  return createHmac("sha256", requireDocumentSigningSecret()).update(payload).digest("base64url")
}

export function createExecutedFileAccessToken(fileId: string, expiresInSeconds = 60 * 60 * 24 * 30) {
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds
  const payload = Buffer.from(JSON.stringify({ fileId, expiresAt })).toString("base64url")
  const signature = signPayload(payload)
  return `${payload}.${signature}`
}

export function parseExecutedFileAccessToken(token: string): { fileId: string } | null {
  const [payload, signature] = token.split(".")
  if (!payload || !signature) return null

  const expectedSignature = signPayload(payload)
  if (expectedSignature.length !== signature.length) return null

  const expected = Buffer.from(expectedSignature)
  const actual = Buffer.from(signature)
  if (!timingSafeEqual(expected, actual)) return null

  let parsed: { fileId?: unknown; expiresAt?: unknown } | null = null
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return null
  }

  if (!parsed || typeof parsed.fileId !== "string" || typeof parsed.expiresAt !== "number") return null
  if (parsed.expiresAt <= Math.floor(Date.now() / 1000)) return null

  return { fileId: parsed.fileId }
}
