"use client"

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"

import { AlertCircle, Loader2, ShieldCheck } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp"
import { createClient } from "@/lib/supabase/client"
import { evaluatePaymentStepUp, type AuthenticationMethodFact } from "@/lib/payments/step-up-policy"

/**
 * The second factor a payment approval needs, asked for before the approval.
 *
 * The rule was enforced only on the server, so an approver clicked "Approve
 * $48,000", waited, and got a raw thrown error string. Worse, the freshness
 * window is ten minutes: someone who signed in at the start of a meeting was
 * refused with no explanation and no way to fix it from where they stood.
 *
 * This is a pre-check, never the control. `decidePaymentRun` still calls
 * `requireRecentPaymentStepUp`, and the same pure policy decides both, so a
 * client that lied about being verified would simply fail one step later.
 */
export function PaymentStepUpGate({
  children,
  description,
}: {
  /** Rendered once the session satisfies the policy. */
  children: React.ReactNode
  description?: string
}) {
  const supabase = useMemo(() => createClient(), [])
  const [checking, setChecking] = useState(true)
  const [satisfied, setSatisfied] = useState(false)
  const [factorId, setFactorId] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const check = useCallback(async () => {
    const { data, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (assuranceError) {
      setError(assuranceError.message)
      setSatisfied(false)
      return false
    }
    const methods: AuthenticationMethodFact[] = (data?.currentAuthenticationMethods ?? []).flatMap((method) =>
      typeof method === "string" ? [] : [{ method: method.method ?? null, timestamp: method.timestamp ?? null }],
    )
    const decision = evaluatePaymentStepUp({ assuranceLevel: data?.currentLevel, methods })
    setSatisfied(decision.satisfied)
    return decision.satisfied
  }, [supabase])

  useEffect(() => {
    let active = true
    const init = async () => {
      const ok = await check()
      if (!active) return
      if (!ok) {
        const { data: factors } = await supabase.auth.mfa.listFactors()
        const verified = factors?.totp.find((factor) => factor.status === "verified")
        if (active) setFactorId(verified?.id ?? null)
      }
      if (active) setChecking(false)
    }
    void init()
    return () => {
      active = false
    }
  }, [check, supabase])

  const verify = () => {
    if (!factorId || code.length !== 6 || isPending) return
    setError(null)
    startTransition(async () => {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId, code })
      if (verifyError) {
        setError(verifyError.message)
        setCode("")
        return
      }
      setCode("")
      await check()
    })
  }

  if (checking) {
    return (
      <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Checking your two-factor status…
      </div>
    )
  }

  if (satisfied) return <>{children}</>

  if (!factorId) {
    return (
      <div role="alert" className="border border-warning bg-warning/10 px-4 py-3 text-sm">
        <p className="flex items-center gap-2 font-medium">
          <AlertCircle className="size-4" />
          Two-factor authentication required
        </p>
        <p className="mt-1 text-muted-foreground">
          Releasing money needs a second factor on your account. Add an authenticator app in your profile security
          settings, then come back to this run.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3 border border-border p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-muted-foreground" />
        <p className="text-sm font-medium">Confirm it&rsquo;s you</p>
      </div>
      <p className="text-sm text-muted-foreground">
        {description ?? "Enter the 6-digit code from your authenticator app to approve this payment."}
      </p>
      <div className="flex justify-center">
        <InputOTP maxLength={6} value={code} onChange={setCode} onComplete={verify} disabled={isPending}>
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
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button className="w-full" disabled={code.length !== 6 || isPending} onClick={verify}>
        {isPending ? "Verifying…" : "Verify"}
      </Button>
    </div>
  )
}
