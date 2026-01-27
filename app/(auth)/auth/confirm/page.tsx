import { redirect } from "next/navigation"
import type { EmailOtpType } from "@supabase/supabase-js"

import { createServerSupabaseClient } from "@/lib/supabase/server"

interface ConfirmPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

export default async function ConfirmPage({ searchParams }: ConfirmPageProps) {
  const resolvedSearchParams = await searchParams
  const code = typeof resolvedSearchParams?.code === "string" ? resolvedSearchParams.code : null
  const tokenHash = typeof resolvedSearchParams?.token_hash === "string" ? resolvedSearchParams.token_hash : null
  const type = typeof resolvedSearchParams?.type === "string" ? resolvedSearchParams.type : null
  const nextParam = typeof resolvedSearchParams?.next === "string" ? resolvedSearchParams.next : "/"
  const next = nextParam.startsWith("/") ? nextParam : "/"

  if (!code && !tokenHash) {
    redirect("/auth/signin")
  }

  const supabase = await createServerSupabaseClient()
  const { error } = tokenHash
    ? await supabase.auth.verifyOtp({
        type: (type as EmailOtpType) ?? "invite",
        token_hash: tokenHash,
      })
    : await supabase.auth.exchangeCodeForSession(code as string)

  if (error) {
    return (
      <div className="space-y-4">
        <div>
          <p className="text-sm uppercase tracking-[0.2em] text-white/60">Confirm access</p>
          <h2 className="mt-2 text-2xl font-semibold text-white">Invalid or expired link</h2>
          <p className="text-sm text-white/60">Request a new invite or reset link to continue.</p>
        </div>
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error.message}
        </div>
      </div>
    )
  }

  redirect(next)
}
