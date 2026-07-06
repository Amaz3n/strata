import "server-only"

import crypto from "node:crypto"
import http2 from "node:http2"

// Apple Push Notification service (APNs) sender. Entirely env-gated: when the
// APNS_* variables are absent every entry point is a no-op, so the app ships
// push-ready and delivery activates the moment credentials are configured.
//
// Required env:
//   APNS_KEY_ID       - the .p8 key's Key ID
//   APNS_TEAM_ID      - Apple Developer Team ID
//   APNS_AUTH_KEY     - the .p8 private key PEM (newlines may be escaped as \n)
//   APNS_BUNDLE_ID    - the app bundle id / APNs topic (e.g. com.arc.mobile)
// Optional:
//   APNS_ENVIRONMENT  - "production" (default) or "sandbox"

interface ApnsConfig {
  keyId: string
  teamId: string
  authKey: string
  bundleId: string
  host: string
}

function readConfig(): ApnsConfig | null {
  const keyId = process.env.APNS_KEY_ID
  const teamId = process.env.APNS_TEAM_ID
  const authKey = process.env.APNS_AUTH_KEY
  const bundleId = process.env.APNS_BUNDLE_ID
  if (!keyId || !teamId || !authKey || !bundleId) return null
  const sandbox = process.env.APNS_ENVIRONMENT === "sandbox"
  return {
    keyId,
    teamId,
    authKey: authKey.replace(/\\n/g, "\n"),
    bundleId,
    host: sandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com",
  }
}

export function isApnsConfigured(): boolean {
  return readConfig() !== null
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url")
}

// APNs provider tokens are valid 20-60 minutes; reuse a signed token for ~50
// minutes to avoid TooManyProviderTokenUpdates throttling.
let cachedToken: { value: string; issuedAt: number } | null = null

function providerToken(config: ApnsConfig): string {
  const now = Math.floor(Date.now() / 1000)
  if (cachedToken && now - cachedToken.issuedAt < 50 * 60) {
    return cachedToken.value
  }
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }))
  const payload = base64url(JSON.stringify({ iss: config.teamId, iat: now }))
  const signingInput = `${header}.${payload}`
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: config.authKey,
    dsaEncoding: "ieee-p1363",
  })
  const value = `${signingInput}.${base64url(signature)}`
  cachedToken = { value, issuedAt: now }
  return value
}

export interface ApnsResult {
  ok: boolean
  status: number
  // When true the device token is no longer valid and should be deleted.
  unregistered: boolean
  reason?: string
}

export interface ApnsPayload {
  deviceToken: string
  title: string
  body: string
  badge?: number
  data?: Record<string, unknown>
}

export async function sendApnsNotification(input: ApnsPayload): Promise<ApnsResult> {
  const config = readConfig()
  if (!config) return { ok: false, status: 0, unregistered: false, reason: "apns_not_configured" }

  const token = providerToken(config)
  const body = JSON.stringify({
    aps: {
      alert: { title: input.title, body: input.body },
      sound: "default",
      ...(input.badge != null ? { badge: input.badge } : {}),
    },
    ...(input.data ?? {}),
  })

  return new Promise<ApnsResult>((resolve) => {
    const client = http2.connect(config.host)
    let settled = false
    const finish = (result: ApnsResult) => {
      if (settled) return
      settled = true
      client.close()
      resolve(result)
    }

    client.on("error", (error) => finish({ ok: false, status: 0, unregistered: false, reason: String(error) }))

    const request = client.request({
      ":method": "POST",
      ":path": `/3/device/${input.deviceToken}`,
      authorization: `bearer ${token}`,
      "apns-topic": config.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    })

    let status = 0
    let responseBody = ""
    request.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0)
    })
    request.setEncoding("utf8")
    request.on("data", (chunk) => {
      responseBody += chunk
    })
    request.on("end", () => {
      let reason: string | undefined
      try {
        reason = responseBody ? (JSON.parse(responseBody).reason as string) : undefined
      } catch {
        reason = responseBody || undefined
      }
      finish({
        ok: status === 200,
        status,
        unregistered: status === 410 || reason === "BadDeviceToken" || reason === "Unregistered",
        reason,
      })
    })
    request.on("error", (error) => finish({ ok: false, status: 0, unregistered: false, reason: String(error) }))
    request.write(body)
    request.end()
  })
}
