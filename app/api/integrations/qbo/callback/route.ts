import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"

import { exchangeCodeForTokens, fetchQBOCompanyInfo } from "@/lib/integrations/accounting/qbo-auth"
import { upsertQBOConnection } from "@/lib/services/qbo-connection"
import { requireOrgMembership } from "@/lib/auth/context"
import { logQBO } from "@/lib/services/qbo-logger"

function clearOAuthCookies(response: NextResponse, request: NextRequest) {
  const secure = request.nextUrl.protocol === "https:"
  const names = ["qbo_oauth_state", "qbo_oauth_popup"]

  for (const name of names) {
    response.cookies.set({
      name,
      value: "",
      httpOnly: name === "qbo_oauth_state",
      path: "/",
      sameSite: "lax",
      maxAge: 0,
      secure,
    })
  }
}

function completeOAuth(request: NextRequest, redirectPath: string, status: "success" | "error") {
  const isPopupFlow = request.cookies.get("qbo_oauth_popup")?.value === "1"

  if (!isPopupFlow) {
    const response = NextResponse.redirect(new URL(redirectPath, request.url))
    clearOAuthCookies(response, request)
    return response
  }

  const origin = request.nextUrl.origin
  const fallbackUrl = new URL(redirectPath, request.url).toString()
  const payload = JSON.stringify({
    type: "arc:qbo-oauth-complete",
    status,
    redirectPath,
  })

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Finishing QuickBooks connection...</title>
  </head>
  <body>
    <script>
      (function () {
        var payload = ${payload};
        var targetOrigin = ${JSON.stringify(origin)};
        var fallbackUrl = ${JSON.stringify(fallbackUrl)};
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, targetOrigin);
          window.close();
          setTimeout(function () {
            window.location.replace(fallbackUrl);
          }, 300);
          return;
        }
        window.location.replace(fallbackUrl);
      })();
    </script>
  </body>
</html>`

  const response = new NextResponse(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  })
  clearOAuthCookies(response, request)
  return response
}

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
    return completeOAuth(request, "/settings?tab=integrations&error=qbo_denied", "error")
  }

  if (!code || !realmId || !state) {
    return completeOAuth(request, "/settings?tab=integrations&error=qbo_invalid", "error")
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
    return completeOAuth(request, "/settings?tab=integrations&error=qbo_state_mismatch", "error")
  }

  const [orgId, nonce] = state.split(":")
  if (!orgId || !nonce) {
    return completeOAuth(request, "/settings?tab=integrations&error=qbo_state_mismatch", "error")
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

    return completeOAuth(request, "/settings?tab=integrations&success=qbo_connected", "success")
  } catch (err) {
    logQBO("error", "oauth_callback_failed", { orgId, realmId, error: String(err) })
    return completeOAuth(request, "/settings?tab=integrations&error=qbo_failed", "error")
  }
}

export const runtime = "nodejs"
