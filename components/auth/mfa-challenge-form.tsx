"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { AlertCircle, Loader2, ShieldCheck } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  InputOTPSeparator,
} from "@/components/ui/input-otp"
import { createClient } from "@/lib/supabase/client"

export function MfaChallengeForm() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(true)
  const [factorId, setFactorId] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    let isMounted = true

    const init = async () => {
      const { data: userResult } = await supabase.auth.getUser()
      if (!userResult.user) {
        router.replace("/auth/signin")
        return
      }

      const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (assuranceError) {
        if (isMounted) {
          setError(assuranceError.message)
          setLoading(false)
        }
        return
      }

      const requiresMfa = assurance.nextLevel === "aal2" && assurance.currentLevel !== "aal2"
      if (!requiresMfa) {
        router.replace("/")
        return
      }

      const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors()
      if (factorsError) {
        if (isMounted) {
          setError(factorsError.message)
          setLoading(false)
        }
        return
      }

      const verifiedTotp = factorsData.totp.find((factor) => factor.status === "verified")
      if (!verifiedTotp) {
        if (isMounted) {
          setError("No verified authenticator was found for this account.")
          setLoading(false)
        }
        return
      }

      if (isMounted) {
        setFactorId(verifiedTotp.id)
        setLoading(false)
      }
    }

    init()
    return () => {
      isMounted = false
    }
  }, [router, supabase.auth])

  const submit = () => {
    if (!factorId || code.length !== 6 || isPending) return

    setError(null)
    startTransition(async () => {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId,
        code,
      })

      if (verifyError) {
        setError(verifyError.message)
        setCode("")
        return
      }

      router.replace("/")
      router.refresh()
    })
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace("/auth/signin")
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Preparing authenticator challenge...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex size-12 items-center justify-center bg-primary/10 text-primary">
          <ShieldCheck className="size-6" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Two-factor verification</h1>
        <p className="text-sm text-muted-foreground text-balance">
          Enter the 6-digit code from your authenticator app.
        </p>
      </div>

      <div className="grid gap-4">
        <div className="flex justify-center">
          <InputOTP
            maxLength={6}
            value={code}
            onChange={setCode}
            onComplete={submit}
            disabled={isPending || !factorId}
            autoFocus
          >
            <InputOTPGroup>
              <InputOTPSlot index={0} />
              <InputOTPSlot index={1} />
              <InputOTPSlot index={2} />
            </InputOTPGroup>
            <InputOTPSeparator />
            <InputOTPGroup>
              <InputOTPSlot index={3} />
              <InputOTPSlot index={4} />
              <InputOTPSlot index={5} />
            </InputOTPGroup>
          </InputOTP>
        </div>

        {error && (
          <div className="flex items-start gap-2 border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Button type="button" onClick={submit} disabled={!factorId || code.length !== 6 || isPending}>
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Verifying...
              </>
            ) : (
              "Verify code"
            )}
          </Button>
          <Button type="button" variant="outline" onClick={handleSignOut} disabled={isPending}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  )
}
