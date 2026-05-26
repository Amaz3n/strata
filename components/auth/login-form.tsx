"use client"

import Link from "next/link"
import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { ArrowLeft } from "lucide-react"

import {
  lookupSignInAccountAction,
  sendFirstPasswordSetupAction,
  signInAction,
  type AuthState,
  type SignInAccountState,
} from "@/app/(auth)/auth/actions"
import { AlertCircle, CheckCircle, Loader2, Mail, ShieldCheck } from "@/components/icons"
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
  inactiveAccount = false,
  inviteOnlySignup = false,
  routeMessage = null,
  ...props
}: React.ComponentProps<"div"> & {
  inactiveAccount?: boolean
  inviteOnlySignup?: boolean
  routeMessage?: string | null
}) {
  const [state, formAction, pending] = useActionState(signInAction, initialState)
  const [step, setStep] = useState<"email" | "password" | "setup" | "mfa">("email")
  const [email, setEmail] = useState("")
  const [accountState, setAccountState] = useState<SignInAccountState | null>(null)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [setupMessage, setSetupMessage] = useState<string | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [isLookupPending, startLookupTransition] = useTransition()
  const [isSetupPending, startSetupTransition] = useTransition()
  const emailInputRef = useRef<HTMLInputElement>(null)
  const passwordInputRef = useRef<HTMLInputElement>(null)
  const displayError =
    (step === "password" ? state.error : null) ??
    lookupError ??
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

  useEffect(() => {
    if (step === "email") {
      emailInputRef.current?.focus()
      return
    }

    if (step === "password") {
      window.requestAnimationFrame(() => passwordInputRef.current?.focus())
    }
  }, [step])

  const submitEmailLookup = () => {
    if (isLookupPending) return

    setLookupError(null)
    setSetupError(null)
    setSetupMessage(null)

    startLookupTransition(async () => {
      const result = await lookupSignInAccountAction(email)
      setAccountState(result)

      if (result.status === "password") {
        setEmail(result.email)
        setStep("password")
        return
      }

      if (result.status === "setup") {
        setEmail(result.email)
        setStep("setup")
        return
      }

      setLookupError(result.message ?? "We could not find an active account for that email.")
    })
  }

  const sendSetupLink = () => {
    if (!email || isSetupPending) return

    setSetupError(null)
    setSetupMessage(null)
    startSetupTransition(async () => {
      const result = await sendFirstPasswordSetupAction(email)
      if (result.error) {
        setSetupError(result.error)
        return
      }
      setSetupMessage(result.message ?? "Check your email for a secure setup link.")
    })
  }

  const goBackToEmail = () => {
    setStep("email")
    setAccountState(null)
    setLookupError(null)
    setSetupError(null)
    setSetupMessage(null)
    setCode("")
    setMfaError(null)
  }

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
    setStep("email")
    setFactorId(null)
    setCode("")
    setMfaError(null)
  }

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{resolveTitle(step)}</h1>
        <p className="text-sm text-muted-foreground text-balance">
          {resolveDescription(step, accountState?.orgName)}
        </p>
      </div>

      <div>
        {/* Email step */}
        <div className={cn(step !== "email" && "hidden")}>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              submitEmailLookup()
            }}
            className="grid gap-4"
          >
            <div className="grid gap-2">
              <Label htmlFor="email">Work email</Label>
              <Input
                ref={emailInputRef}
                id="email"
                type="email"
                placeholder="you@company.com"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>

            {displayError && (
              <div className="flex items-start gap-2 border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>{displayError}</span>
              </div>
            )}

            {routeMessage && !displayError && (
              <div className="flex items-start gap-2 border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5 text-sm text-emerald-700 dark:text-emerald-300">
                <CheckCircle className="mt-0.5 size-4 shrink-0" />
                <span>{routeMessage}</span>
              </div>
            )}

            <Button type="submit" className="w-full" disabled={isLookupPending}>
              {isLookupPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Checking account...
                </>
              ) : (
                "Continue"
              )}
            </Button>
          </form>

          {inviteOnlySignup && (
            <div className="mt-4 border border-primary/20 bg-primary/5 px-3 py-2.5 text-sm text-primary">
              Account creation is managed by organization admins. Ask your admin for an invite.
            </div>
          )}
        </div>

        {/* Password step */}
        <div className={cn(step !== "password" && "hidden")}>
          <form action={formAction} className="grid gap-4">
            <input type="hidden" name="email" value={email} />

            <div className="flex items-center gap-2 border border-border bg-muted/40 px-3 py-2 text-sm">
              <Mail className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{email}</span>
              <button
                type="button"
                onClick={goBackToEmail}
                className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Change
              </button>
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
                ref={passwordInputRef}
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
        </div>

        {/* First-time setup step */}
        <div className={cn(step !== "setup" && "hidden")}>
          <div className="grid gap-4">
            <div className="flex items-center gap-2 border border-border bg-muted/40 px-3 py-2 text-sm">
              <Mail className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{email}</span>
              <button
                type="button"
                onClick={goBackToEmail}
                className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Change
              </button>
            </div>

            <div className="border border-primary/20 bg-primary/5 px-4 py-3">
              <div className="flex items-start gap-3">
                <div className="grid size-9 shrink-0 place-items-center bg-primary/10 text-primary">
                  <ShieldCheck className="size-4" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">Your account is ready for setup.</p>
                  <p className="text-sm text-muted-foreground">
                    We&apos;ll email a secure link so you can create your password and enter the workspace.
                  </p>
                </div>
              </div>
            </div>

            {setupError && (
              <div className="flex items-start gap-2 border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>{setupError}</span>
              </div>
            )}

            {setupMessage && (
              <div className="flex items-start gap-2 border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5 text-sm text-emerald-700 dark:text-emerald-300">
                <CheckCircle className="mt-0.5 size-4 shrink-0" />
                <span>{setupMessage}</span>
              </div>
            )}

            <Button type="button" className="w-full" onClick={sendSetupLink} disabled={isSetupPending}>
              {isSetupPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Sending setup link...
                </>
              ) : (
                "Email setup link"
              )}
            </Button>
          </div>
        </div>

        {/* MFA step */}
        <div className={cn(step !== "mfa" && "hidden")}>
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

      <p className="text-center text-xs leading-relaxed text-muted-foreground">
        By continuing, you agree to Arc&apos;s{" "}
        <Link href="/terms" className="underline-offset-4 hover:text-foreground hover:underline">
          Terms of Service
        </Link>{" "}
        and{" "}
        <Link href="/privacy" className="underline-offset-4 hover:text-foreground hover:underline">
          Privacy Policy
        </Link>
        .
      </p>
    </div>
  )
}

function resolveTitle(step: "email" | "password" | "setup" | "mfa") {
  if (step === "password") return "Enter your password"
  if (step === "setup") return "Set up your account"
  if (step === "mfa") return "Two-factor verification"
  return "Welcome to Arc"
}

function resolveDescription(step: "email" | "password" | "setup" | "mfa", orgName?: string | null) {
  if (step === "password") return orgName ? `Sign in to ${orgName}.` : "Sign in to your workspace."
  if (step === "setup") return orgName ? `Create access for ${orgName}.` : "Create access for your workspace."
  if (step === "mfa") return "Enter the 6-digit code from your authenticator app."
  return "Enter your work email to continue to your workspace."
}
