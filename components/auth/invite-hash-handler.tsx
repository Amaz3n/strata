"use client"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import { normalizeInternalReturnPath } from "@/lib/auth/return-path"
import { useAuthHash } from "@/components/auth/use-auth-hash"

const DEFAULT_INVITE_REDIRECT = "/auth/reset"

function parseHashParams(hash: string) {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash
  return new URLSearchParams(trimmed)
}

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return null
  return createClient()
}

export function InviteHashHandler() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const hash = useAuthHash()
  const next = normalizeInternalReturnPath(searchParams.get("next"), DEFAULT_INVITE_REDIRECT)

  useEffect(() => {
    if (hash === null) return
    setError(null)
    setProcessing(false)

    const params = parseHashParams(hash)
    const accessToken = params.get("access_token")
    const refreshToken = params.get("refresh_token")
    const hashError = params.get("error_description") ?? params.get("error")

    if (hashError) {
      setError(hashError)
      return
    }

    if (!accessToken || !refreshToken) {
      if (accessToken || refreshToken) setError("This invitation link is incomplete. Please ask for a new link.")
      return
    }

    const supabase = getSupabaseClient()
    if (!supabase) {
      setError("Supabase configuration is missing.")
      return
    }

    let active = true
    setProcessing(true)
    supabase.auth
      .setSession({ access_token: accessToken, refresh_token: refreshToken })
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
        setError(err instanceof Error ? err.message : "Unable to finish invite sign-in.")
      })
      .finally(() => {
        if (active) setProcessing(false)
      })
    return () => { active = false }
  }, [router, hash, next])

  if (!error && !processing) return null

  return (
    <div role={processing ? "status" : "alert"} className="mb-6 rounded-lg border border-muted/40 bg-muted/10 px-4 py-3 text-sm">
      {processing ? (
        <span className="text-muted-foreground">Finishing your invite…</span>
      ) : (
        <span className="text-destructive">{error}</span>
      )}
    </div>
  )
}
