"use client"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { createClient } from "@supabase/supabase-js"

const DEFAULT_INVITE_REDIRECT = "/auth/reset"

function parseHashParams(hash: string) {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash
  return new URLSearchParams(trimmed)
}

function getNextRedirect(searchParams: URLSearchParams) {
  const nextParam = searchParams.get("next") ?? DEFAULT_INVITE_REDIRECT
  return nextParam.startsWith("/") ? nextParam : DEFAULT_INVITE_REDIRECT
}

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return null
  return createClient(url, anonKey)
}

export function InviteHashHandler() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)

  useEffect(() => {
    if (typeof window === "undefined") return

    const params = parseHashParams(window.location.hash)
    const accessToken = params.get("access_token")
    const refreshToken = params.get("refresh_token")
    const hashError = params.get("error_description") ?? params.get("error")

    if (hashError) {
      setError(decodeURIComponent(hashError))
      return
    }

    if (!accessToken || !refreshToken) return

    const supabase = getSupabaseClient()
    if (!supabase) {
      setError("Supabase configuration is missing.")
      return
    }

    setProcessing(true)
    const next = getNextRedirect(searchParams)
    supabase.auth
      .setSession({ access_token: accessToken, refresh_token: refreshToken })
      .then(({ error: sessionError }) => {
        if (sessionError) {
          setError(sessionError.message)
          return
        }
        router.replace(next)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Unable to finish invite sign-in.")
      })
      .finally(() => {
        setProcessing(false)
      })
  }, [router, searchParams])

  if (!error && !processing) return null

  return (
    <div className="mb-6 rounded-lg border border-muted/40 bg-muted/10 px-4 py-3 text-sm">
      {processing ? (
        <span className="text-muted-foreground">Finishing your invite…</span>
      ) : (
        <span className="text-destructive">{error}</span>
      )}
    </div>
  )
}
