"use client"

import { useEffect, useMemo, useState, Suspense } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"

import { ResetPasswordForm } from "@/components/auth/reset-password-form"

function createSupabaseClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return null
  return createClient(url, anonKey)
}

function AuthResetContent() {
  const searchParams = useSearchParams()
  const code = searchParams.get("code")
  const supabase = useMemo(() => createSupabaseClient(), [])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) {
      setError("Supabase configuration is missing.")
      setLoading(false)
      return
    }

    const verifySession = async () => {
      try {
        if (code) {
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
          if (exchangeError) {
            setError(exchangeError.message)
            setLoading(false)
            return
          }
        }

        const { data } = await supabase.auth.getSession()
        if (!data.session) {
          setError("Your reset link is invalid or has expired.")
          setLoading(false)
          return
        }

        setLoading(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to verify your session.")
        setLoading(false)
      }
    }

    verifySession()
  }, [code, supabase])

  if (loading) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm uppercase tracking-[0.2em] text-white/60">Reset access</p>
        <h2 className="text-2xl font-semibold text-white">Preparing your account</h2>
        <p className="text-sm text-white/60">Hang tight while we verify your link.</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-4">
        <div>
          <p className="text-sm uppercase tracking-[0.2em] text-white/60">Reset access</p>
          <h2 className="mt-2 text-2xl font-semibold text-white">Invalid or expired link</h2>
          <p className="text-sm text-white/60">Request a new reset link to continue.</p>
        </div>
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
        <div className="text-sm text-white/60">
          <Link href="/auth/signin" className="underline">
            Back to sign in
          </Link>
        </div>
      </div>
    )
  }

  if (!supabase) {
    return null
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm uppercase tracking-[0.2em] text-white/60">Reset access</p>
        <h2 className="mt-2 text-2xl font-semibold text-white">Choose a new password</h2>
        <p className="text-sm text-white/60">After updating, you will be signed in automatically.</p>
      </div>
      <ResetPasswordForm supabase={supabase} />
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="text-white">Loading...</div>}>
      <AuthResetContent />
    </Suspense>
  )
}