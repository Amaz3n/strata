import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "crypto"
import { qboApiBaseUrl } from "@/lib/integrations/accounting/qbo/config"

const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET
const rawAppUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL ?? "http://localhost:3000"
const normalizedAppUrl = rawAppUrl.startsWith("http") ? rawAppUrl : `https://${rawAppUrl}`
const QBO_REDIRECT_URI = `${normalizedAppUrl.replace(/\/$/, "")}/api/integrations/qbo/callback`
const QBO_SCOPES = "com.intuit.quickbooks.accounting"

export interface QBOTokens {
  access_token: string
  refresh_token: string
  expires_in: number
  x_refresh_token_expires_in?: number
  realm_id?: string
}

function requireEnv(value: string | undefined, name: string) {
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`)
  }
  return value
}

/**
 * The QBO OAuth client_id (app) the current runtime is configured with.
 * Read at call time so it reflects the actual process env. Used to ensure a
 * connection is only ever refreshed by the same app that minted its tokens —
 * refreshing with a different client_id (e.g. dev keys against a prod token)
 * is rejected by Intuit and would otherwise expire the connection.
 */
export function getQBOClientId(): string | null {
  return process.env.QBO_CLIENT_ID ?? null
}

function getEncryptionKey(): Buffer {
  const raw = requireEnv(process.env.TOKEN_ENCRYPTION_KEY, "TOKEN_ENCRYPTION_KEY")
  if (raw.length === 32) return Buffer.from(raw)
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === 64) return Buffer.from(raw, "hex")
  try {
    const buf = Buffer.from(raw, "base64")
    if (buf.length === 32) return buf
  } catch {
    // fall through to error
  }
  throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes (raw, hex, or base64)")
}

function signOAuthState(orgId: string, nonce: string): string {
  return createHmac("sha256", getEncryptionKey()).update(`${orgId}:${nonce}`).digest("base64url")
}

export function createQBOOAuthState(orgId: string): string {
  const nonce = randomBytes(16).toString("base64url")
  return `${orgId}:${nonce}:${signOAuthState(orgId, nonce)}`
}

export function verifyQBOOAuthState(state: string): { orgId: string; nonce: string } | null {
  const [orgId, nonce, signature] = state.split(":")
  if (!orgId || !nonce || !signature) return null

  const expected = signOAuthState(orgId, nonce)
  const expectedBuffer = Buffer.from(expected)
  const receivedBuffer = Buffer.from(signature)
  if (expectedBuffer.length !== receivedBuffer.length) return null
  if (!timingSafeEqual(expectedBuffer, receivedBuffer)) return null

  return { orgId, nonce }
}

export function getQBOAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv(QBO_CLIENT_ID, "QBO_CLIENT_ID"),
    response_type: "code",
    scope: QBO_SCOPES,
    redirect_uri: QBO_REDIRECT_URI,
    state,
  })

  const baseUrl = "https://appcenter.intuit.com/connect/oauth2"
  return `${baseUrl}?${params.toString()}`
}

export async function exchangeCodeForTokens(code: string, realmId: string): Promise<QBOTokens> {
  const credentials = Buffer.from(
    `${requireEnv(QBO_CLIENT_ID, "QBO_CLIENT_ID")}:${requireEnv(QBO_CLIENT_SECRET, "QBO_CLIENT_SECRET")}`,
  ).toString("base64")

  const response = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: QBO_REDIRECT_URI,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`QBO token exchange failed: ${error}`)
  }

  const tokens = (await response.json()) as QBOTokens
  return { ...tokens, realm_id: realmId }
}

export async function refreshAccessToken(refreshToken: string): Promise<QBOTokens> {
  const credentials = Buffer.from(
    `${requireEnv(QBO_CLIENT_ID, "QBO_CLIENT_ID")}:${requireEnv(QBO_CLIENT_SECRET, "QBO_CLIENT_SECRET")}`,
  ).toString("base64")

  const response = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  })

  if (!response.ok) {
    const error = await response.text().catch(() => "unknown")
    throw new Error(`QBO token refresh failed: ${error}`)
  }

  return (await response.json()) as QBOTokens
}

export async function revokeQBOToken(token: string): Promise<void> {
  const credentials = Buffer.from(
    `${requireEnv(QBO_CLIENT_ID, "QBO_CLIENT_ID")}:${requireEnv(QBO_CLIENT_SECRET, "QBO_CLIENT_SECRET")}`,
  ).toString("base64")

  const response = await fetch("https://developer.api.intuit.com/v2/oauth2/tokens/revoke", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Basic ${credentials}`,
    },
    body: JSON.stringify({ token }),
  })

  if (!response.ok) {
    const error = await response.text().catch(() => "unknown")
    throw new Error(`QBO token revoke failed: ${error}`)
  }
}

export function encryptToken(token: string): string {
  const key = getEncryptionKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString("base64")
}

export function decryptToken(encrypted: string): string {
  const key = getEncryptionKey()
  const buffer = Buffer.from(encrypted, "base64")
  const iv = buffer.subarray(0, 12)
  const tag = buffer.subarray(12, 28)
  const payload = buffer.subarray(28)
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(payload), decipher.final()])
  return decrypted.toString("utf8")
}

export async function fetchQBOCompanyInfo(accessToken: string, realmId: string) {
  const response = await fetch(`${qboApiBaseUrl}/v3/company/${realmId}/companyinfo/${realmId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  })

  if (!response.ok) return null
  const data = await response.json().catch(() => null)
  return (data as any)?.CompanyInfo ?? null
}

export async function detectInvoiceNumberPattern(accessToken: string, realmId: string) {
  // Scan a window of recent invoices and take the numeric max — the most recently
  // *created* invoice is not necessarily the highest-numbered one.
  const query = `SELECT DocNumber FROM Invoice ORDERBY MetaData.CreateTime DESC MAXRESULTS 50`
  const response = await fetch(`${qboApiBaseUrl}/v3/company/${realmId}/query?query=${encodeURIComponent(query)}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  })

  if (!response.ok) {
    return {
      invoice_number_pattern: "numeric" as const,
      invoice_number_prefix: null as string | null,
      last_known_invoice_number: null as string | null,
    }
  }

  const payload = (await response.json().catch(() => ({}))) as any
  const rows = (payload?.QueryResponse?.Invoice ?? []) as Array<{ DocNumber?: string }>
  const docNumber =
    rows
      .map((row) => (typeof row.DocNumber === "string" ? row.DocNumber.trim() : ""))
      .filter(Boolean)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }))[0] ?? undefined

  if (!docNumber) {
    return {
      invoice_number_pattern: "numeric" as const,
      invoice_number_prefix: null as string | null,
      last_known_invoice_number: null as string | null,
    }
  }

  // Basic pattern detection for numeric/prefix/year-based formats
  if (/^\d+$/.test(docNumber)) {
    return {
      invoice_number_pattern: "numeric" as const,
      invoice_number_prefix: null as string | null,
      last_known_invoice_number: docNumber,
    }
  }

  const prefixMatch = docNumber.match(/^([A-Za-z-]+)(\d+)$/)
  if (prefixMatch) {
    return {
      invoice_number_pattern: "prefix" as const,
      invoice_number_prefix: prefixMatch[1],
      last_known_invoice_number: docNumber,
    }
  }

  const yearMatch = docNumber.match(/^(\d{4}-)(\d+)$/)
  if (yearMatch) {
    return {
      invoice_number_pattern: "prefix" as const,
      invoice_number_prefix: yearMatch[1],
      last_known_invoice_number: docNumber,
    }
  }

  return {
    invoice_number_pattern: "custom" as const,
    invoice_number_prefix: null as string | null,
    last_known_invoice_number: docNumber,
  }
}
