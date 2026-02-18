"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { AlertCircle, Loader2, ShieldCheck } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
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
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle>Two-factor verification</CardTitle>
          <CardDescription>Preparing your authenticator challenge...</CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <CardTitle>Two-factor verification</CardTitle>
        <CardDescription>Enter the 6-digit code from your authenticator app.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex justify-center">
          <InputOTP
            maxLength={6}
            value={code}
            onChange={setCode}
            onComplete={submit}
            disabled={isPending || !factorId}
          >
            <InputOTPGroup>
              <InputOTPSlot index={0} />
              <InputOTPSlot index={1} />
              <InputOTPSlot index={2} />
              <InputOTPSlot index={3} />
              <InputOTPSlot index={4} />
              <InputOTPSlot index={5} />
            </InputOTPGroup>
          </InputOTP>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex gap-2">
          <Button type="button" className="w-full" onClick={submit} disabled={!factorId || code.length !== 6 || isPending}>
            {isPending ? "Verifying..." : "Verify code"}
          </Button>
          <Button type="button" variant="outline" onClick={handleSignOut} disabled={isPending}>
            Sign out
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
