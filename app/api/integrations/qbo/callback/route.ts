import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"

import { exchangeCodeForTokens, fetchQBOCompanyInfo, verifyQBOOAuthState } from "@/lib/integrations/accounting/qbo/auth"
import { upsertQBOConnection } from "@/lib/integrations/accounting/qbo/connections"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { requireAccountingConnectionForOrg } from "@/lib/services/accounting-connections"
import { accountingOAuthCookieName } from "@/lib/integrations/accounting/oauth-state"
import { logQBO } from "@/lib/services/accounting-logger"

function completeOAuth(request: NextRequest, redirectPath: string) {
  const response = NextResponse.redirect(new URL(redirectPath, request.url))
  const state = verifyQBOOAuthState(request.nextUrl.searchParams.get("state") ?? "")
  if (state)
    response.cookies.set({
      name: accountingOAuthCookieName(state),
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

  const verifiedState = verifyQBOOAuthState(state)
  if (!verifiedState) return completeOAuth(request, "/settings?tab=integrations&error=qbo_state_mismatch")
  const cookieName = accountingOAuthCookieName(verifiedState)
  let savedState = request.cookies.get(cookieName)?.value
  if (!savedState) {
    const cookieStore = await cookies()
    savedState = cookieStore.get(cookieName)?.value
  }
  if (!savedState || state !== savedState) return completeOAuth(request, "/settings?tab=integrations&error=qbo_state_mismatch")
  const { orgId } = verifiedState
  try {
    const ctx = await requireOrgContext(orgId)
    await requirePermission("org.admin", ctx)
    if (ctx.userId !== verifiedState.userId) throw new Error("Authorization attempt belongs to another user")
    if (verifiedState.connectionId) {
      const existing = await requireAccountingConnectionForOrg(verifiedState.connectionId, orgId, { provider: "qbo" })
      if (existing.external_account_id !== verifiedState.expectedAccountId || realmId !== existing.external_account_id) {
        throw new Error("Reconnect company identity changed; start a separate connection instead")
      }
    }
    const connectedBy = ctx.userId

    const tokens = await exchangeCodeForTokens(code, realmId)
    const companyInfo = await fetchQBOCompanyInfo(tokens.access_token, realmId)

    await upsertQBOConnection({
      ...(verifiedState.connectionId ? { connectionId: verifiedState.connectionId } : {}),
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
