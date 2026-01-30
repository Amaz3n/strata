export interface Env {
  DRAWINGS_TILES: R2Bucket
  TILES_COOKIE_SECRET: string
  TILES_COOKIE_NAME?: string
}

const DEFAULT_COOKIE_NAME = "arc_tiles"
const PATH_PREFIX = "/drawing-tiles/"

function getCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null
  const parts = cookieHeader.split(";")
  for (const part of parts) {
    const [key, ...rest] = part.trim().split("=")
    if (key === name) return rest.join("=")
  }
  return null
}

function base64UrlToBytes(input: string) {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
  const raw = atob(padded)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i)
  }
  return bytes
}

function bytesToBase64Url(bytes: ArrayBuffer) {
  const raw = String.fromCharCode(...new Uint8Array(bytes))
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function hmacSha256(secret: string, data: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))
  return bytesToBase64Url(sig)
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

async function validateCookie(token: string, secret: string) {
  const [payloadB64, sig] = token.split(".")
  if (!payloadB64 || !sig) return false
  const expected = await hmacSha256(secret, payloadB64)
  if (!safeEqual(expected, sig)) return false

  const payloadBytes = base64UrlToBytes(payloadB64)
  const payloadJson = new TextDecoder().decode(payloadBytes)
  const payload = JSON.parse(payloadJson) as { exp?: number }
  const now = Math.floor(Date.now() / 1000)
  return typeof payload.exp === "number" && payload.exp > now
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith(PATH_PREFIX)) {
      return new Response("Not found", { status: 404 })
    }

    const cookieName = env.TILES_COOKIE_NAME || DEFAULT_COOKIE_NAME
    const token = getCookieValue(request.headers.get("Cookie"), cookieName)
    if (!token || !env.TILES_COOKIE_SECRET) {
      return new Response("Unauthorized", { status: 401 })
    }

    const ok = await validateCookie(token, env.TILES_COOKIE_SECRET)
    if (!ok) {
      return new Response("Unauthorized", { status: 401 })
    }

    const objectKey = url.pathname.slice(PATH_PREFIX.length)
    if (!objectKey) {
      return new Response("Not found", { status: 404 })
    }

    const object = await env.DRAWINGS_TILES.get(objectKey)
    if (!object) {
      return new Response("Not found", { status: 404 })
    }

    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set("etag", object.httpEtag)
    headers.set("Cache-Control", headers.get("Cache-Control") ?? "public, max-age=31536000, immutable")

    return new Response(object.body, { headers })
  },
}
