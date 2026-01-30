import { NextRequest, NextResponse } from "next/server"
import { createHmac } from "node:crypto"

import { requireOrgMembership } from "@/lib/auth/context"

const COOKIE_NAME = process.env.DRAWINGS_TILES_COOKIE_NAME ?? "arc_tiles"
const COOKIE_SECRET = process.env.DRAWINGS_TILES_COOKIE_SECRET
const COOKIE_DOMAIN = process.env.DRAWINGS_TILES_COOKIE_DOMAIN ?? ".arcnaples.com"
const COOKIE_PATH = process.env.DRAWINGS_TILES_COOKIE_PATH ?? "/drawing-tiles/"
const COOKIE_TTL_SECONDS = Number(process.env.DRAWINGS_TILES_COOKIE_TTL_SECONDS ?? "3600")

function base64UrlEncode(value: string) {
  return Buffer.from(value).toString("base64url")
}

function signPayload(payloadB64: string, secret: string) {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url")
}

function buildSignedToken(payload: Record<string, any>, secret: string) {
  const payloadJson = JSON.stringify(payload)
  const payloadB64 = base64UrlEncode(payloadJson)
  const signature = signPayload(payloadB64, secret)
  return `${payloadB64}.${signature}`
}

async function handleRequest(request: NextRequest) {
  if (!COOKIE_SECRET) {
    return NextResponse.json({ error: "Missing DRAWINGS_TILES_COOKIE_SECRET" }, { status: 500 })
  }

  const { user, orgId } = await requireOrgMembership()

  const now = Math.floor(Date.now() / 1000)
  const exp = now + COOKIE_TTL_SECONDS
  const token = buildSignedToken({ sub: user.id, org_id: orgId, exp }, COOKIE_SECRET)

  const response = NextResponse.json({ ok: true, exp })
  response.headers.set("Cache-Control", "no-store")
  response.cookies.set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    domain: COOKIE_DOMAIN,
    path: COOKIE_PATH,
    maxAge: COOKIE_TTL_SECONDS,
  })

  return response
}

export async function GET(request: NextRequest) {
  return handleRequest(request)
}

export async function POST(request: NextRequest) {
  return handleRequest(request)
}

export const runtime = "nodejs"
