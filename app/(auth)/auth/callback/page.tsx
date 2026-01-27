"use client"

import { useEffect, useState } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { createClient } from "@supabase/supabase-js"

function parseHashParams(hash: string) {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash
  return new URLSearchParams(trimmed)
}

export default function AuthCallbackPage() {
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
      router.replace("/auth/signin")
      return
    }

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
    <div className="bg-background flex min-h-svh flex-col items-center justify-center gap-4 p-6 md:p-10">
      <div className="w-full max-w-sm space-y-4 text-center">
        <h2 className="text-xl font-semibold">Finishing sign-in…</h2>
        <p className="text-sm text-muted-foreground">
          We are setting up your account and redirecting you.
        </p>
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
