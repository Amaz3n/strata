"use client"

import { useEffect, useMemo, useState, Suspense } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/client"
import { ArrowLeft } from "lucide-react"

import { Loader2, AlertCircle } from "@/components/icons"
import { ResetPasswordForm } from "@/components/auth/reset-password-form"
import { ExternalResetPasswordForm } from "@/components/auth/external-reset-password-form"
import { useAuthHash } from "@/components/auth/use-auth-hash"

function createSupabaseClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return null
  return createClient()
}

function AuthResetContent({ externalToken, hash }: { externalToken: string | null; hash: string | null }) {
  const supabase = useMemo(() => externalToken ? null : createSupabaseClient(), [externalToken])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Externals have no Supabase session to verify — the server checks their raw
    // token when the new password is submitted.
    if (externalToken) {
      setLoading(false)
      return
    }
    if (hash === null) return

    if (!supabase) {
      setError("Supabase configuration is missing.")
      setLoading(false)
      return
    }

    let active = true
    let requestUrl = window.location.href
    const isCurrent = () => active && window.location.href === requestUrl
    const verifySession = async () => {
      try {
        if (hash) {
          const hashParams = new URLSearchParams(hash.replace(/^#/, ""))
          const hashError = hashParams.get("error_description") ?? hashParams.get("error")
          if (hashError) {
            setError(hashError)
            return
          }
          const accessToken = hashParams.get("access_token")
          const refreshToken = hashParams.get("refresh_token")
          if ((accessToken || refreshToken) && (!accessToken || !refreshToken)) {
            setError("This reset link is incomplete. Please request a new link.")
            return
          }
          if (accessToken && refreshToken) {
            const { error: sessionError } = await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            })
            if (!isCurrent()) return
            if (sessionError) {
              setError(sessionError.message)
              return
            }

            window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`)
            requestUrl = window.location.href
          }
        }

        const { data } = await supabase.auth.getSession()
        if (!isCurrent()) return
        if (!data.session) {
          setError("Your reset link is invalid or has expired.")
          return
        }
      } catch (err) {
        if (isCurrent()) setError(err instanceof Error ? err.message : "Unable to verify your session.")
      } finally {
        if (isCurrent()) setLoading(false)
      }
    }

    verifySession()
    return () => { active = false }
  }, [externalToken, hash, supabase])

  if (loading) {
    return (
      <div role="status" className="flex flex-col items-center gap-3 py-8">
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

        <div role="alert" className="flex items-start gap-2 border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
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

  if (externalToken) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
          <p className="text-sm text-muted-foreground text-balance">
            Updating signs you out on your other devices.
          </p>
        </div>
        <ExternalResetPasswordForm token={externalToken} />
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

function AuthResetRoute() {
  const searchParams = useSearchParams()
  const externalToken = searchParams.get("external_token")
  const hash = useAuthHash()
  const identity = externalToken
    ? JSON.stringify(["external", externalToken])
    : JSON.stringify(["internal", searchParams.toString(), hash])
  return <AuthResetContent key={identity} externalToken={externalToken} hash={hash} />
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
      <AuthResetRoute />
    </Suspense>
  )
}
