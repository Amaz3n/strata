import type { EmailOtpType } from "@supabase/supabase-js"
import { NextResponse } from "next/server"

import { normalizeInternalReturnPath } from "@/lib/auth/return-path"
import { createServerSupabaseClient } from "@/lib/supabase/server"

const emailOtpTypes = new Set<EmailOtpType>([
  "signup", "invite", "magiclink", "recovery", "email_change", "email",
])

// Session exchange must run in a Route Handler: Server Components cannot
// persist the cookies returned by Supabase, even when verification succeeds.
export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const tokenHash = url.searchParams.get("token_hash")
  const type = url.searchParams.get("type") ?? "invite"
  const next = normalizeInternalReturnPath(url.searchParams.get("next"))
  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, url.origin), {
    headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
  })

  if (!code && !tokenHash) return redirectTo("/auth/signin")
  if (tokenHash && !emailOtpTypes.has(type as EmailOtpType)) return redirectTo("/auth/confirm/error")

  const supabase = await createServerSupabaseClient()
  const { error } = tokenHash
    ? await supabase.auth.verifyOtp({ type: type as EmailOtpType, token_hash: tokenHash })
    : await supabase.auth.exchangeCodeForSession(code!)

  return redirectTo(error ? "/auth/confirm/error" : next)
}
