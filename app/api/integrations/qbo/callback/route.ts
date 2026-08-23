import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"

import { exchangeCodeForTokens, fetchQBOCompanyInfo, verifyQBOOAuthState } from "@/lib/integrations/accounting/qbo/auth"
import { upsertQBOConnection } from "@/lib/integrations/accounting/qbo/connections"
import { requireOrgMembership } from "@/lib/auth/context"
import { logQBO } from "@/lib/services/accounting-logger"

function completeOAuth(request: NextRequest, redirectPath: string) {
  const response = NextResponse.redirect(new URL(redirectPath, request.url))
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
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get("code")
  const state = searchParams.get("state")
  const realmId = searchParams.get("realmId")
  const error = searchParams.get("error")

  if (error) {
    return completeOAuth(request, "/settings?tab=integrations&error=qbo_denied")
  }

  if (!code || !realmId || !state) {
    return completeOAuth(request, "/settings?tab=integrations&error=qbo_invalid")
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

  // Signed state only. The unsigned `orgId:nonce` fallback predates
  // verifyQBOOAuthState and kept a weaker path alive on a credential-issuing
  // endpoint; the cookie compare remains as defense in depth, not as an
  // alternative to the signature.
  const verifiedState = verifyQBOOAuthState(state)
  if (!verifiedState || (savedState && state !== savedState)) {
    return completeOAuth(request, "/settings?tab=integrations&error=qbo_state_mismatch")
  }
  const { orgId, nonce } = verifiedState

  if (!orgId || !nonce) {
    return completeOAuth(request, "/settings?tab=integrations&error=qbo_state_mismatch")
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
      refreshTokenExpiresInSeconds: tokens.x_refresh_token_expires_in,
      connectedBy,
      companyName: (companyInfo as any)?.CompanyName ?? (companyInfo as any)?.LegalName ?? null,
    })
    logQBO("info", "oauth_callback_connected", { orgId, realmId, connectedBy })

    return completeOAuth(request, "/settings?tab=integrations&success=qbo_connected")
  } catch (err) {
    logQBO("error", "oauth_callback_failed", { orgId, realmId, error: String(err) })
    return completeOAuth(request, "/settings?tab=integrations&error=qbo_failed")
  }
}
