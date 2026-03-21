"use client"

import { useEffect, useState, Suspense } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { createClient } from "@supabase/supabase-js"

import { Loader2, AlertCircle } from "@/components/icons"

function parseHashParams(hash: string) {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash
  return new URLSearchParams(trimmed)
}

function AuthCallbackContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const nextParam = searchParams.get("next") ?? "/"
    const next = nextParam.startsWith("/") ? nextParam : "/"
    const params = parseHashParams(window.location.hash)
    const accessToken = params.get("access_token")
    const refreshToken = params.get("refresh_token")

    if (!accessToken || !refreshToken) {
      if (typeof window !== 'undefined' && !window.location.hash) {
         router.replace("/auth/signin")
         return
      }
      if (!params.get("access_token")) return
    }

    if (!accessToken || !refreshToken) return

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !anonKey) {
      setError("Supabase configuration is missing.")
      return
    }

    const supabase = createClient(url, anonKey)
    supabase.auth
      .setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      })
      .then(({ error: sessionError }) => {
        if (sessionError) {
          setError(sessionError.message)
          return
        }
        router.replace(next)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Unable to complete sign-in.")
      })
  }, [searchParams, router])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-3 py-4">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <div className="text-center">
          <h1 className="text-lg font-semibold">Finishing sign-in...</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Setting up your account and redirecting you.
          </p>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
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
