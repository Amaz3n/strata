"use client"

import { useEffect, useState, Suspense } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"
import { normalizeInternalReturnPath } from "@/lib/auth/return-path"
import { useAuthHash } from "@/components/auth/use-auth-hash"

import { Loader2, AlertCircle } from "@/components/icons"

function parseHashParams(hash: string) {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash
  return new URLSearchParams(trimmed)
}

function AuthCallbackContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const hash = useAuthHash()
  const next = normalizeInternalReturnPath(searchParams.get("next"))

  useEffect(() => {
    if (hash === null) return
    setError(null)
    if (!hash) {
      router.replace("/auth/signin")
      return
    }
    const params = parseHashParams(hash)
    const accessToken = params.get("access_token")
    const refreshToken = params.get("refresh_token")

    if (params.get("error") || params.get("error_description")) {
      setError(params.get("error_description") || "This sign-in link is invalid or has expired.")
      return
    }
    if (!accessToken || !refreshToken) {
      setError("This sign-in link is incomplete. Please request a new link.")
      return
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !anonKey) {
      setError("Supabase configuration is missing.")
      return
    }

    let active = true
    const supabase = createClient()
    supabase.auth
      .setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      })
      .then(({ error: sessionError }) => {
        if (!active) return
        if (sessionError) {
          setError(sessionError.message)
          return
        }
        router.replace(next)
      })
      .catch((err) => {
        if (!active) return
        setError(err instanceof Error ? err.message : "Unable to complete sign-in.")
      })
    return () => { active = false }
  }, [hash, next, router])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-3 py-4">
        {!error && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
        <div className="text-center">
          <h1 className="text-lg font-semibold">{error ? "Unable to sign in" : "Finishing sign-in..."}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {error ? "Request a new link or return to sign in." : "Setting up your account and redirecting you."}
          </p>
        </div>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {error && <Link href="/auth/signin" className="text-sm underline">Back to sign in</Link>}
    </div>
  )
}

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col items-center gap-3 py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      }
    >
      <AuthCallbackContent />
    </Suspense>
  )
}
