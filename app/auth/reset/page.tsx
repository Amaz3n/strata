import { redirect } from "next/navigation"

import { ResetPasswordForm } from "@/components/auth/reset-password-form"
import { createServerSupabaseClient } from "@/lib/supabase/server"

interface ResetPageProps {
  searchParams: { [key: string]: string | string[] | undefined }
}

export default async function ResetPasswordPage({ searchParams }: ResetPageProps) {
  const code = typeof searchParams?.code === "string" ? searchParams.code : null

  if (!code) {
    redirect("/auth/signin")
  }

  const supabase = createServerSupabaseClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    return (
      <div className="space-y-4">
        <div>
          <p className="text-sm uppercase tracking-[0.2em] text-white/60">Reset access</p>
          <h2 className="mt-2 text-2xl font-semibold text-white">Invalid or expired link</h2>
          <p className="text-sm text-white/60">Request a new reset link to continue.</p>
        </div>
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error.message}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm uppercase tracking-[0.2em] text-white/60">Reset access</p>
        <h2 className="mt-2 text-2xl font-semibold text-white">Choose a new password</h2>
        <p className="text-sm text-white/60">After updating, you will be signed in automatically.</p>
      </div>
      <ResetPasswordForm />
    </div>
  )
}
