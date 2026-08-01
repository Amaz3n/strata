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
import { AlertCircle, Building2, CheckCircle, Loader2, ShieldCheck } from "@/components/icons"
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

type Step = "email" | "password" | "setup" | "mfa"

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
  const [step, setStep] = useState<Step>("email")
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

  // Step transition: the panel slides forward on advance, back on "Change",
  // and its height eases between steps so the card never jumps.
  const stepRef = useRef<HTMLDivElement>(null)
  const [stepHeight, setStepHeight] = useState<number>()
  const directionRef = useRef(1)

  // MFA state
  const supabase = useMemo(() => createClient(), [])
  const [factorId, setFactorId] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [mfaError, setMfaError] = useState<string | null>(null)
  const [isMfaPending, startMfaTransition] = useTransition()
  const [mfaLoading, setMfaLoading] = useState(false)

  useEffect(() => {
    const el = stepRef.current
    if (!el) return
    const sync = () => setStepHeight(el.offsetHeight)
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => observer.disconnect()
  }, [step])

  useEffect(() => {
    if (!state.mfaRequired) return

    directionRef.current = 1
    setStep("mfa")
    setMfaLoading(true)

    const loadFactor = async () => {
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

    loadFactor()
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
        directionRef.current = 1
        setStep("password")
        return
      }

      setEmail(result.email)
      directionRef.current = 1
      setStep("setup")
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
    directionRef.current = -1
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
    directionRef.current = -1
    setStep("email")
    setFactorId(null)
    setCode("")
    setMfaError(null)
  }

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{resolveTitle(step)}</h1>
        {step === "mfa" && (
          <p className="text-base leading-relaxed text-muted-foreground">
            Enter the 6-digit code from your authenticator app.
          </p>
        )}
      </div>

      {/* Negative margin gives focus rings room inside the clipped panel. */}
      <div
        className="-m-1 overflow-hidden transition-[height] duration-300 ease-out motion-reduce:transition-none"
        style={{ height: stepHeight }}
      >
        <div
          key={step}
          ref={stepRef}
          className={cn(
            "p-1 duration-300 ease-out animate-in fade-in-0 motion-reduce:animate-none",
            directionRef.current === 1 ? "slide-in-from-right-4" : "slide-in-from-left-4",
          )}
        >
          {step === "email" && (
            <div className="grid gap-4">
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  submitEmailLookup()
                }}
                className="grid gap-4"
              >
                <div className="grid gap-2">
                  <Label htmlFor="email" className="text-sm">Work email</Label>
                  <Input
                    ref={emailInputRef}
                    id="email"
                    type="email"
                    placeholder="you@company.com"
                    autoComplete="email"
                    className="h-11 md:text-base"
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

                <Button type="submit" className="h-11 w-full text-base" disabled={isLookupPending}>
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
                <div className="border border-primary/20 bg-primary/5 px-3 py-2.5 text-sm text-primary">
                  Account creation is managed by organization admins. Ask your admin for an invite.
                </div>
              )}
            </div>
          )}

          {step === "password" && (
            <form action={formAction} className="grid gap-4">
              <input type="hidden" name="email" value={email} />

              <WorkspaceRow email={email} onChange={goBackToEmail} />

              <div className="grid gap-2">
                <div className="flex items-center">
                  <Label htmlFor="password" className="text-sm">Password</Label>
                  <Link
                    href="/auth/forgot-password"
                    className="ml-auto text-sm text-muted-foreground underline-offset-4 hover:underline"
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
                  className="h-11 md:text-base"
                  required
                />
              </div>

              {displayError && (
                <div className="flex items-start gap-2 border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span>{displayError}</span>
                </div>
              )}

              <Button type="submit" className="h-11 w-full text-base" disabled={pending}>
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
          )}

          {step === "setup" && (
            <div className="grid gap-4">
              <WorkspaceRow email={email} onChange={goBackToEmail} />

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

              <Button type="button" className="h-11 w-full text-base" onClick={sendSetupLink} disabled={isSetupPending}>
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
          )}

          {step === "mfa" && (
            <div className="grid gap-4">
              {mfaLoading ? (
                <div className="flex items-center gap-2.5 py-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Preparing authenticator challenge...
                </div>
              ) : (
                <>
                  <InputOTP
                    maxLength={6}
                    value={code}
                    onChange={setCode}
                    onComplete={submitMfa}
                    disabled={isMfaPending || !factorId}
                    autoFocus
                  >
                    <InputOTPGroup>
                      <InputOTPSlot index={0} className="size-12 text-lg" />
                      <InputOTPSlot index={1} className="size-12 text-lg" />
                      <InputOTPSlot index={2} className="size-12 text-lg" />
                    </InputOTPGroup>
                    <InputOTPSeparator />
                    <InputOTPGroup>
                      <InputOTPSlot index={3} className="size-12 text-lg" />
                      <InputOTPSlot index={4} className="size-12 text-lg" />
                      <InputOTPSlot index={5} className="size-12 text-lg" />
                    </InputOTPGroup>
                  </InputOTP>

                  {mfaError && (
                    <div className="flex items-start gap-2 border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                      <AlertCircle className="mt-0.5 size-4 shrink-0" />
                      <span>{mfaError}</span>
                    </div>
                  )}

                  <Button
                    type="button"
                    className="h-11 w-full text-base"
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

                  <button
                    type="button"
                    onClick={handleSignOut}
                    disabled={isMfaPending}
                    className="inline-flex items-center gap-1.5 justify-self-start text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
                  >
                    <ArrowLeft className="size-3.5" />
                    Use a different account
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <p className="text-center text-sm leading-relaxed text-muted-foreground">
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

/** Which workspace you're signing into, with the account underneath it. */
function WorkspaceRow({
  email,
  onChange,
}: {
  email: string
  onChange: () => void
}) {
  return (
    <div className="flex items-center gap-3 border border-border bg-muted/40 px-3.5 py-3">
      <div className="grid size-10 shrink-0 place-items-center bg-primary/10 text-primary">
        <Building2 className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-medium">{email}</p>
      </div>
      <button
        type="button"
        onClick={onChange}
        className="shrink-0 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Change
      </button>
    </div>
  )
}

function resolveTitle(step: Step) {
  if (step === "password") return "Enter your password"
  if (step === "setup") return "Set up your account"
  if (step === "mfa") return "Two-factor verification"
  return "Welcome to Arc"
}
