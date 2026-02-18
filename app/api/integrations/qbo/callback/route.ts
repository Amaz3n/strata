import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"

import { exchangeCodeForTokens, fetchQBOCompanyInfo } from "@/lib/integrations/accounting/qbo-auth"
import { upsertQBOConnection } from "@/lib/services/qbo-connection"
import { requireOrgMembership } from "@/lib/auth/context"
import { logQBO } from "@/lib/services/qbo-logger"

export async function GET(request: NextRequest) {
  // Force Node runtime to ensure cookies API supports get/set.
  // (Edge/runtime differences can otherwise break cookie access.)
  // See: https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config#runtime
  // runtime is declared at the bottom of the file.
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get("code")
  const state = searchParams.get("state")
  const realmId = searchParams.get("realmId")
  const error = searchParams.get("error")

  if (error) {
    return NextResponse.redirect(new URL("/settings?tab=integrations&error=qbo_denied", request.url))
  }

  if (!code || !realmId || !state) {
    return NextResponse.redirect(new URL("/settings?tab=integrations&error=qbo_invalid", request.url))
  }

  // Prefer request-scoped cookies (more reliable on Vercel/edge-adjacent runtimes).
  let savedState = request.cookies.get("qbo_oauth_state")?.value
  if (!savedState) {
    try {
      const cookieStore = await cookies()
      savedState = cookieStore.get("qbo_oauth_state")?.value
    } catch {
      // ignore
    }
  }

  if (!savedState || state !== savedState) {
    return NextResponse.redirect(new URL("/settings?tab=integrations&error=qbo_state_mismatch", request.url))
  }

  const [orgId, nonce] = state.split(":")
  if (!orgId || !nonce) {
    return NextResponse.redirect(new URL("/settings?tab=integrations&error=qbo_state_mismatch", request.url))
  }

  try {
    const { user } = await requireOrgMembership(orgId)
    const connectedBy = user.id

    const tokens = await exchangeCodeForTokens(code, realmId)
    const companyInfo = await fetchQBOCompanyInfo(tokens.access_token, realmId)

    await upsertQBOConnection({
      orgId,
      realmId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresInSeconds: tokens.expires_in,
      connectedBy,
      companyName: (companyInfo as any)?.CompanyName ?? (companyInfo as any)?.LegalName ?? null,
    })
    logQBO("info", "oauth_callback_connected", { orgId, realmId, connectedBy })

    const response = NextResponse.redirect(new URL("/settings?tab=integrations&success=qbo_connected", request.url))
    response.cookies.set({
      name: "qbo_oauth_state",
      value: "",
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      maxAge: 0,
      secure: request.nextUrl.protocol === "https:",
    })

    return response
  } catch (err) {
    logQBO("error", "oauth_callback_failed", { orgId, realmId, error: String(err) })
    return NextResponse.redirect(new URL("/settings?tab=integrations&error=qbo_failed", request.url))
  }
}

export const runtime = "nodejs"
