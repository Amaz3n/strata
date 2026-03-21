"use client"

import { useEffect, useMemo, useState, Suspense } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { createClient, type EmailOtpType, type SupabaseClient } from "@supabase/supabase-js"
import { ArrowLeft } from "lucide-react"

import { Loader2, AlertCircle } from "@/components/icons"
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
  const tokenHash = searchParams.get("token_hash")
  const tokenType = searchParams.get("type")
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
        } else if (tokenHash) {
          const { error: verifyError } = await supabase.auth.verifyOtp({
            type: (tokenType as EmailOtpType) ?? "recovery",
            token_hash: tokenHash,
          })
          if (verifyError) {
            setError(verifyError.message)
            setLoading(false)
            return
          }
        } else if (typeof window !== "undefined" && window.location.hash) {
          const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""))
          const accessToken = hashParams.get("access_token")
          const refreshToken = hashParams.get("refresh_token")
          if (accessToken && refreshToken) {
            const { error: sessionError } = await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            })
            if (sessionError) {
              setError(sessionError.message)
              setLoading(false)
              return
            }

            window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}`)
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
  }, [code, supabase, tokenHash, tokenType])

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Verifying your reset link...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Invalid or expired link</h1>
          <p className="text-sm text-muted-foreground text-balance">
            Request a new reset link to continue.
          </p>
        </div>

        <div className="flex items-start gap-2 border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>

        <div className="text-center">
          <Link
            href="/auth/forgot-password"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            <ArrowLeft className="size-3.5" />
            Request new link
          </Link>
        </div>
      </div>
    )
  }

  if (!supabase) return null

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
        <p className="text-sm text-muted-foreground text-balance">
          After updating, you&apos;ll be signed in automatically.
        </p>
      </div>
      <ResetPasswordForm supabase={supabase} />
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col items-center gap-3 py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      }
    >
      <AuthResetContent />
    </Suspense>
  )
}
