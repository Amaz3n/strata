"use client"

import { useCallback, useMemo, useState, useTransition } from "react"

import { AlertCircle, ShieldCheck } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp"
import { createClient } from "@/lib/supabase/client"
import { evaluatePaymentStepUp, type AuthenticationMethodFact } from "@/lib/payments/step-up-policy"

type Pending = { factorId: string; action: () => void } | null

/**
 * Whether a server error is the step-up rule rather than a real failure.
 *
 * Some payment paths only demand a second factor conditionally — recording an
 * external payment does so above the org's per-payment limit — so the client
 * cannot know in advance whether to ask. Recognising the refusal turns a
 * dead-end toast into the same challenge, and the caller retries.
 */
export function isPaymentStepUpError(message: string) {
  return /two-factor authentication is required|complete a new two-factor challenge|verification expired/i.test(message)
}

/**
 * The second factor a payment decision needs, asked for at the moment of the
 * decision.
 *
 * The rule is that the session carries a genuine second factor verified in the
 * last ten minutes. Almost nobody does — you sign in once in the morning — so
 * enforcing it server-side alone meant clicking "Approve $48,000" and getting a
 * raw error string back. Checking it up front is barely better: it puts a code
 * box in front of a decision the approver has not read yet.
 *
 * So nothing is asked until the action is taken. Review freely, press the
 * button, and only then — and only if the session has gone stale — enter a code.
 * The action runs the instant it verifies, so the code is a step inside the
 * decision rather than a gate in front of it.
 *
 * This is convenience, never the control. `decidePaymentRun` still calls
 * `requireRecentPaymentStepUp`, and both sides read the same pure policy, so a
 * client that skipped this would simply fail one step later.
 */
export function usePaymentStepUp() {
  const supabase = useMemo(() => createClient(), [])
  const [pending, setPending] = useState<Pending>(null)
  const [noFactor, setNoFactor] = useState(false)
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [verifying, startVerifying] = useTransition()

  const isSatisfied = useCallback(async () => {
    const { data, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (assuranceError) return false
    const methods: AuthenticationMethodFact[] = (data?.currentAuthenticationMethods ?? []).flatMap((method) =>
      typeof method === "string" ? [] : [{ method: method.method ?? null, timestamp: method.timestamp ?? null }],
    )
    return evaluatePaymentStepUp({ assuranceLevel: data?.currentLevel, methods }).satisfied
  }, [supabase])

  /**
   * Run `action`, asking for a code first only if the session needs one. The
   * caller writes the happy path and never branches on authentication.
   */
  const requireStepUp = useCallback(
    async (action: () => void) => {
      if (await isSatisfied()) {
        action()
        return
      }
      const { data: factors } = await supabase.auth.mfa.listFactors()
      const verified = factors?.totp.find((factor) => factor.status === "verified")
      if (!verified) {
        setNoFactor(true)
        return
      }
      setCode("")
      setError(null)
      setPending({ factorId: verified.id, action })
    },
    [isSatisfied, supabase],
  )

  const verify = (value: string) => {
    if (!pending || value.length !== 6 || verifying) return
    setError(null)
    startVerifying(async () => {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: pending.factorId,
        code: value,
      })
      if (verifyError) {
        setError(verifyError.message)
        setCode("")
        return
      }
      const action = pending.action
      setPending(null)
      setCode("")
      action()
    })
  }

  const stepUpPrompt = (
    <>
      <Dialog open={pending !== null} onOpenChange={(open) => (open ? undefined : setPending(null))}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-muted-foreground" />
              Confirm it&rsquo;s you
            </DialogTitle>
            <DialogDescription>
              Enter the 6-digit code from your authenticator app to release this payment.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-center py-2">
            <InputOTP
              maxLength={6}
              autoFocus
              value={code}
              onChange={(value) => {
                setCode(value)
                if (value.length === 6) verify(value)
              }}
              disabled={verifying}
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
          {error ? (
            <p role="alert" className="text-center text-sm text-destructive">
              {error}
            </p>
          ) : (
            <p className="text-center text-xs text-muted-foreground">
              {verifying ? "Verifying…" : "The payment goes through as soon as this verifies."}
            </p>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={noFactor} onOpenChange={(open) => (open ? undefined : setNoFactor(false))}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="size-4 text-warning" />
              Two-factor authentication required
            </DialogTitle>
            <DialogDescription>
              Releasing money needs a second factor on your account. Add an authenticator app in your profile security
              settings, then come back to this payment.
            </DialogDescription>
          </DialogHeader>
          <Button className="w-full" onClick={() => setNoFactor(false)}>
            Got it
          </Button>
        </DialogContent>
      </Dialog>
    </>
  )

  return { requireStepUp, stepUpPrompt, stepUpPending: verifying }
}
