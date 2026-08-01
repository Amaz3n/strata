import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

function encryptionKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY
  if (!raw) throw new Error("Missing environment variable: TOKEN_ENCRYPTION_KEY")
  if (raw.length === 32) return Buffer.from(raw)
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex")
  const decoded = Buffer.from(raw, "base64")
  if (decoded.length === 32) return decoded
  throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes (raw, hex, or base64)")
}

export function encryptIntegrationSecret(value: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")
}

export function decryptIntegrationSecret(value: string) {
  const payload = Buffer.from(value, "base64")
  const iv = payload.subarray(0, 12)
  const tag = payload.subarray(12, 28)
  const encrypted = payload.subarray(28)
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")
}

