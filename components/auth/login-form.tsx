"use client"

import Link from "next/link"
import { useActionState, useEffect, useMemo, useState, useTransition } from "react"
import { useSearchParams } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { signInAction, type AuthState } from "@/app/(auth)/auth/actions"
import { AlertCircle, Loader2, ShieldCheck } from "@/components/icons"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  InputOTPSeparator,
} from "@/components/ui/input-otp"
import { createClient } from "@/lib/supabase/client"

const initialState: AuthState = { error: undefined, message: undefined, mfaRequired: undefined }

export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const [state, formAction, pending] = useActionState(signInAction, initialState)
  const [step, setStep] = useState<"credentials" | "mfa">("credentials")
  const searchParams = useSearchParams()
  const inactiveAccount = searchParams.get("reason") === "inactive-account"
  const inviteOnlySignup = searchParams.get("reason") === "invite-only"
  const displayError =
    state.error ??
    (inactiveAccount ? "This account has been archived. Contact your organization admin to restore access." : null)

  // MFA state
  const supabase = useMemo(() => createClient(), [])
  const [factorId, setFactorId] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [mfaError, setMfaError] = useState<string | null>(null)
  const [isMfaPending, startMfaTransition] = useTransition()
  const [mfaLoading, setMfaLoading] = useState(false)

  useEffect(() => {
    if (!state.mfaRequired) return

    setMfaLoading(true)

    const init = async () => {
      const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors()
      if (factorsError) {
        setMfaError(factorsError.message)
        setMfaLoading(false)
        return
      }

      const verifiedTotp = factorsData.totp.find((f) => f.status === "verified")
      if (!verifiedTotp) {
        setMfaError("No verified authenticator was found for this account.")
        setMfaLoading(false)
        return
      }

      setFactorId(verifiedTotp.id)
      setMfaLoading(false)
    }

    // Brief delay for the transition animation
    const timer = window.setTimeout(() => {
      setStep("mfa")
      init()
    }, 400)

    return () => window.clearTimeout(timer)
  }, [state.mfaRequired, supabase.auth.mfa])

  const submitMfa = () => {
    if (!factorId || code.length !== 6 || isMfaPending) return

    setMfaError(null)
    startMfaTransition(async () => {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId,
        code,
      })

      if (verifyError) {
        setMfaError(verifyError.message)
        setCode("")
        return
      }

      window.location.href = "/"
    })
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    setStep("credentials")
    setFactorId(null)
    setCode("")
    setMfaError(null)
  }

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          {step === "credentials" ? "Welcome back" : "Two-factor verification"}
        </h1>
        <p className="text-sm text-muted-foreground text-balance">
          {step === "credentials"
            ? "Enter your credentials to access your account."
            : "Enter the 6-digit code from your authenticator app."
          }
        </p>
      </div>

      <div className="relative overflow-hidden">
        {/* Credentials step */}
        <div
          className={cn(
            "transition-all duration-300 ease-out",
            step === "mfa" && "-translate-x-full opacity-0 absolute inset-0 pointer-events-none",
          )}
        >
          <form action={formAction} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="you@company.com"
                autoComplete="email"
                required
              />
            </div>
            <div className="grid gap-2">
              <div className="flex items-center">
                <Label htmlFor="password">Password</Label>
                <Link
                  href="/auth/forgot-password"
                  className="ml-auto text-xs text-muted-foreground underline-offset-4 hover:underline"
                >
                  Forgot password?
                </Link>
              </div>
              <Input
                id="password"
                name="password"
                type="password"
                placeholder="&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;"
                autoComplete="current-password"
                required
              />
            </div>

            {displayError && (
              <div className="flex items-start gap-2 border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>{displayError}</span>
              </div>
            )}

            <Button type="submit" className="w-full" disabled={pending || step === "mfa"}>
              {pending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                "Sign in"
              )}
            </Button>
          </form>

          {inviteOnlySignup && (
            <div className="mt-4 border border-primary/20 bg-primary/5 px-3 py-2.5 text-sm text-primary">
              Account creation is managed by organization admins. Ask your admin for an invite.
            </div>
          )}
        </div>

        {/* MFA step */}
        <div
          className={cn(
            "transition-all duration-300 ease-out",
            step === "credentials" && "translate-x-full opacity-0 absolute inset-0 pointer-events-none",
          )}
        >
          <div className="mx-auto grid w-full max-w-[15rem] justify-items-center gap-6">
            <div className="grid size-12 place-items-center bg-primary/10 text-primary">
              <ShieldCheck className="size-6" />
            </div>

            {mfaLoading ? (
              <div className="flex flex-col items-center gap-3 py-4">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Preparing authenticator challenge...</p>
              </div>
            ) : (
              <div className="grid w-full gap-4">
                <div className="grid w-full gap-2">
                  <InputOTP
                    maxLength={6}
                    value={code}
                    onChange={setCode}
                    onComplete={submitMfa}
                    disabled={isMfaPending || !factorId}
                    autoFocus
                    containerClassName="justify-center"
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

                  <div className="grid grid-cols-[auto_1fr] gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={handleSignOut}
                      disabled={isMfaPending}
                    >
                      <ArrowLeft className="size-4" />
                      <span className="sr-only">Back</span>
                    </Button>
                    <Button
                      type="button"
                      onClick={submitMfa}
                      disabled={!factorId || code.length !== 6 || isMfaPending}
                    >
                      {isMfaPending ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          Verifying...
                        </>
                      ) : (
                        "Verify code"
                      )}
                    </Button>
                  </div>
                </div>

                {mfaError && (
                  <div className="flex items-start gap-2 border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                    <span>{mfaError}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
