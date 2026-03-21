import Link from "next/link"
import { redirect } from "next/navigation"
import type { EmailOtpType } from "@supabase/supabase-js"
import { ArrowLeft } from "lucide-react"

import { createServerSupabaseClient } from "@/lib/supabase/server"
import { AlertCircle } from "@/components/icons"

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
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Invalid or expired link</h1>
          <p className="text-sm text-muted-foreground text-balance">
            Request a new invite or reset link to continue.
          </p>
        </div>

        <div className="flex items-start gap-2 border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error.message}</span>
        </div>

        <div className="text-center">
          <Link
            href="/auth/signin"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            <ArrowLeft className="size-3.5" />
            Back to sign in
          </Link>
        </div>
      </div>
    )
  }

  redirect(next)
}
