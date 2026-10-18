"use client"

import { useRouter } from "next/navigation"
import {
  startTransition,
  useActionState,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react"

import {
  lookupSignInAccountAction,
  sendFirstPasswordSetupAction,
  signInAction,
  type SignInState,
  type SignInWelcome,
} from "@/app/(auth)/auth/actions"
import { signalAuthArc } from "@/components/auth/auth-arc"
import { RollingText } from "@/components/auth/rolling-text"
import { User } from "@/components/icons"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"

type Step = "email" | "password" | "setup" | "mfa"
/** Signing in plays in two beats: the button draws its check, then the form gives way to the greeting. */
type Welcome = { title: string; subtitle: string; leaving: boolean }
type Notice = { tone: "error" | "success" | "info"; text: string }

const initialState: SignInState = {}

/** How long the check holds before the form gives way to the greeting. */
const CHECK_HOLD_MS = 650
/** How long the greeting holds before the app opens. */
const GREETING_HOLD_MS = 1500
const OTP_LENGTH = 6
const ARCHIVED_ACCOUNT = "This account has been archived. Contact your organization admin to restore access."

const COPY: Record<Step, { title: string; subtitle: string; action: string }> = {
  email: { title: "Sign in to Arc", subtitle: "Use your work email.", action: "Continue" },
  password: { title: "Welcome back", subtitle: "Enter your password.", action: "Sign in" },
  setup: {
    title: "Set up your account",
    subtitle: "We'll email a secure link so you can create your password.",
    action: "Email setup link",
  },
  mfa: { title: "Verify it's you", subtitle: "Enter the 6-digit code from your authenticator app.", action: "Verify" },
}

const AUX: Record<Step, string | null> = {
  email: "New to Arc? Your admin can send you an invite.",
  password: "Forgot password?",
  setup: null,
  mfa: "Use a different account",
}

/**
 * One form that changes shape between steps instead of swapping screens: the
 * email field becomes the account row, the button becomes the loader, and the
 * words roll from one step to the next. The arc behind it (`AuthArc`) hears
 * about pending work, errors and success through `signalAuthArc`.
 */
export function LoginForm({
  inactiveAccount = false,
  inviteOnlySignup = false,
  routeMessage = null,
  returnTo = "/",
}: {
  inactiveAccount?: boolean
  inviteOnlySignup?: boolean
  routeMessage?: string | null
  returnTo?: string
}) {
  const router = useRouter()
  const [state, formAction, signingIn] = useActionState(signInAction, initialState)
  const [step, setStep] = useState<Step>("email")
  const [email, setEmail] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(inactiveAccount ? ARCHIVED_ACCOUNT : null)
  const [errorSeq, setErrorSeq] = useState(0)
  const [setupMessage, setSetupMessage] = useState<string | null>(null)
  const [welcome, setWelcome] = useState<Welcome | null>(null)
  const [isLookupPending, startLookupTransition] = useTransition()
  const [isSetupPending, startSetupTransition] = useTransition()

  // MFA
  const supabase = useMemo(() => createClient(), [])
  const [factorId, setFactorId] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [isMfaPending, startMfaTransition] = useTransition()
  const [mfaLoading, setMfaLoading] = useState(false)

  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const identRef = useRef<HTMLLabelElement>(null)
  const passwordFieldRef = useRef<HTMLLabelElement>(null)
  const otpRef = useRef<HTMLDivElement>(null)

  const busy = isLookupPending || signingIn || isSetupPending || isMfaPending || mfaLoading
  const locked = step !== "email"
  const copy = COPY[step]
  const aux = AUX[step]
  const leaving = welcome?.leaving ?? false

  const notice: Notice | null = error
    ? { tone: "error", text: error }
    : step === "setup" && setupMessage
      ? { tone: "success", text: setupMessage }
      : step === "email" && routeMessage
        ? { tone: "success", text: routeMessage }
        : step === "email" && inviteOnlySignup
          ? { tone: "info", text: "Account creation is managed by organization admins. Ask your admin for an invite." }
          : null

  const fail = (message: string) => {
    setError(message)
    setErrorSeq((seq) => seq + 1)
  }

  const clearError = () => setError(null)

  const enterWelcome = (welcome: SignInWelcome | undefined, destination: string) => {
    const hour = new Date().getHours()
    const greeting = hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"
    setWelcome({
      title: welcome?.firstName ? `${greeting}, ${welcome.firstName}.` : `${greeting}.`,
      subtitle: `Opening ${welcome?.orgName ?? "Arc"}`,
      leaving: false,
    })
    signalAuthArc({ type: "complete" })
    window.setTimeout(() => setWelcome((current) => current && { ...current, leaving: true }), CHECK_HOLD_MS)
    window.setTimeout(() => window.location.assign(destination), CHECK_HOLD_MS + GREETING_HOLD_MS)
  }

  // The sign-in action answers with an error, a 2FA challenge, or where to go next.
  const onActionResult = useEffectEvent((result: SignInState) => {
    if (result.error) {
      fail(result.error)
      passwordRef.current?.select()
      return
    }
    if (result.mfaRequired) {
      setStep("mfa")
      setMfaLoading(true)
      supabase.auth.mfa.listFactors().then(({ data, error: factorsError }) => {
        setMfaLoading(false)
        if (factorsError) return fail(factorsError.message)
        const verified = data.totp.find((factor) => factor.status === "verified")
        if (!verified) return fail("No verified authenticator was found for this account.")
        setFactorId(verified.id)
      })
      return
    }
    if (result.redirectTo) enterWelcome(result.welcome, result.redirectTo)
  })

  useEffect(() => {
    onActionResult(state)
  }, [state])

  // A wrong answer shakes the field it belongs to and tints the arc.
  const onNewError = useEffectEvent(() => {
    const target = step === "password" ? passwordFieldRef.current : step === "mfa" ? otpRef.current : identRef.current
    if (target) {
      target.classList.remove("auth-shake")
      void target.offsetWidth
      target.classList.add("auth-shake")
    }
    signalAuthArc({ type: "error" })
  })

  useEffect(() => {
    if (errorSeq > 0) onNewError()
  }, [errorSeq])

  useEffect(() => {
    signalAuthArc({ type: "busy", on: busy })
  }, [busy])

  useEffect(() => {
    if (step === "email") emailRef.current?.focus()
    if (step === "password") {
      router.prefetch("/auth/forgot-password")
      const timer = window.setTimeout(() => passwordRef.current?.focus({ preventScroll: true }), 260)
      return () => window.clearTimeout(timer)
    }
  }, [step, router])

  const submitEmail = () => {
    const input = emailRef.current
    if (!input || !email.trim() || !input.checkValidity()) {
      fail("Enter your work email, like you@company.com.")
      input?.focus()
      return
    }
    clearError()
    setSetupMessage(null)
    startLookupTransition(async () => {
      const result = await lookupSignInAccountAction(email)
      setEmail(result.email)
      setStep(result.status === "password" ? "password" : "setup")
    })
  }

  const sendSetupLink = () => {
    clearError()
    setSetupMessage(null)
    startSetupTransition(async () => {
      const result = await sendFirstPasswordSetupAction(email)
      if (result.error) return fail(result.error)
      setSetupMessage(result.message ?? "Check your email for a secure setup link.")
    })
  }

  const submitMfa = () => {
    if (!factorId || code.length !== OTP_LENGTH || isMfaPending) return
    clearError()
    startMfaTransition(async () => {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId, code })
      if (verifyError) {
        setCode("")
        fail(verifyError.message)
        return
      }
      enterWelcome(state.welcome, state.redirectTo ?? returnTo)
    })
  }

  const backToEmail = () => {
    setStep("email")
    setShowPassword(false)
    setSetupMessage(null)
    setCode("")
    setFactorId(null)
    clearError()
  }

  // Past the password the session exists, so "a different account" has to sign out first.
  const switchAccount = async () => {
    await supabase.auth.signOut()
    backToEmail()
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || welcome) return
    if (step === "email") return submitEmail()
    if (step === "setup") return sendSetupLink()
    if (step === "mfa") return submitMfa()
    clearError()
    const data = new FormData(event.currentTarget)
    startTransition(() => formAction(data))
  }

  const onAux = () => {
    if (busy) return
    if (step === "password") router.push("/auth/forgot-password")
    if (step === "mfa") void switchAccount()
  }

  const onFieldInput = () => clearError()

  return (
    <form onSubmit={onSubmit} noValidate aria-live="polite" className="grid">
      <input type="hidden" name="next" value={returnTo} />

      <div className="auth-enter grid gap-2.5" style={enterDelay(0)}>
        <h1 className="text-[clamp(28px,3vw,34px)] leading-[1.12] font-medium tracking-[-0.035em]">
          <RollingText text={leaving && welcome ? welcome.title : copy.title} />
        </h1>
        {/* Two stacked lines, so the step's subtitle rolls out while "Opening …" rolls in
            in its own type — never one line changing typeface mid-animation. */}
        <div className="grid text-(--auth-muted) *:col-start-1 *:row-start-1">
          <p className="text-[15px]">
            <RollingText text={leaving ? "" : copy.subtitle} />
          </p>
          <p className="self-center font-mono text-xs tracking-[0.1em] uppercase">
            <RollingText text={leaving && welcome ? welcome.subtitle : ""} />
          </p>
        </div>
      </div>

      <Fold open={!leaving} gap="lg" enter={1}>
        <label ref={identRef} className="auth-field" data-locked={locked ? "" : undefined}>
          <User className="auth-account-icon" aria-hidden />
          <input
            ref={emailRef}
            className="auth-input"
            name="email"
            type="email"
            aria-label="Work email"
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            readOnly={locked}
            aria-invalid={step === "email" && error ? true : undefined}
            onChange={(event) => {
              setEmail(event.target.value)
              onFieldInput()
            }}
          />
          <span className="auth-kbd" aria-hidden>
            ↵
          </span>
          <button
            type="button"
            className="auth-change text-[13px] text-(--auth-muted) hover:text-(--auth-ink) focus-visible:outline-1 focus-visible:outline-(--auth-accent)"
            tabIndex={locked ? 0 : -1}
            aria-hidden={!locked}
            onClick={step === "mfa" ? () => void switchAccount() : backToEmail}
          >
            Change
          </button>
        </label>
      </Fold>

      <Fold open={step === "password" && !leaving} gap="md">
        <label ref={passwordFieldRef} className="auth-field">
          <input
            ref={passwordRef}
            className="auth-input"
            name="password"
            type={showPassword ? "text" : "password"}
            aria-label="Password"
            autoComplete="current-password"
            placeholder="Password"
            aria-invalid={step === "password" && error ? true : undefined}
            onChange={onFieldInput}
          />
          <button
            type="button"
            className="auth-field-action text-[13px] text-(--auth-muted) hover:text-(--auth-ink) focus-visible:outline-1 focus-visible:outline-(--auth-accent)"
            onClick={() => {
              setShowPassword((shown) => !shown)
              passwordRef.current?.focus({ preventScroll: true })
            }}
          >
            <RollingText text={showPassword ? "Hide" : "Show"} />
          </button>
        </label>
      </Fold>

      <Fold open={step === "mfa" && !leaving} gap="md">
        <div ref={otpRef}>
          <InputOTP
            maxLength={OTP_LENGTH}
            value={code}
            onChange={(value) => {
              setCode(value)
              onFieldInput()
            }}
            onComplete={submitMfa}
            disabled={!factorId}
            autoFocus={step === "mfa"}
            aria-label="Six-digit code"
            containerClassName="w-full"
          >
            <InputOTPGroup className={cn("w-full transition-[gap] duration-500", isMfaPending ? "gap-0" : "gap-2")}>
              {Array.from({ length: OTP_LENGTH }, (_, index) => (
                <InputOTPSlot
                  key={index}
                  index={index}
                  className={cn(
                    "auth-otp-pop h-14 w-auto flex-1 bg-(--auth-field) font-mono text-[22px] [border-color:var(--auth-hair-strong)] data-[active=true]:[border-color:var(--auth-accent)]",
                    !isMfaPending && "border-l",
                  )}
                  style={{ animationDelay: `${120 + index * 45}ms` }}
                />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
      </Fold>

      <Fold open={notice !== null && !leaving} gap="sm">
        <p
          className={cn(
            "auth-note",
            notice?.tone === "error" && "text-destructive",
            notice?.tone === "success" && "text-success",
            notice?.tone === "info" && "text-(--auth-muted)",
          )}
          role={notice?.tone === "error" ? "alert" : undefined}
        >
          <RollingText text={notice?.text ?? ""} />
        </p>
      </Fold>

      <Fold open={!leaving} gap="md" enter={2}>
        <button
          type="submit"
          className="auth-btn"
          data-state={welcome ? "done" : busy ? "busy" : undefined}
          aria-busy={busy}
        >
          <span className="auth-btn-label block">
            <RollingText text={copy.action} />
          </span>
          <span className="auth-btn-glyph" aria-hidden>
            <svg viewBox="0 0 22 22">
              <path className="auth-btn-spin" d="M3 11 A8 8 0 0 1 19 11" />
              <path className="auth-btn-check" pathLength={1} d="M5.5 11.5 L9.5 15.5 L16.5 7" />
            </svg>
          </span>
        </button>
      </Fold>

      <Fold open={aux !== null && !leaving} gap="lg" enter={3}>
        <button
          type="button"
          className={cn(
            "justify-self-start text-left text-[13px] transition-colors focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-(--auth-accent)",
            step === "email" ? "cursor-default text-(--auth-faint)" : "text-(--auth-muted) hover:text-(--auth-ink)",
          )}
          aria-disabled={step === "email"}
          tabIndex={step === "email" ? -1 : 0}
          onClick={onAux}
        >
          <RollingText text={aux ?? ""} />
        </button>
      </Fold>
    </form>
  )
}

/** A row that opens and closes by animating its own height; closed rows are inert. */
function Fold({
  open,
  gap,
  enter,
  children,
}: {
  open: boolean
  gap: "sm" | "md" | "lg"
  /** Position in the first-paint stagger, for rows that are open on arrival. */
  enter?: number
  children: ReactNode
}) {
  return (
    <div className="auth-fold" data-open={open ? "" : undefined} data-gap={gap}>
      <div inert={!open} className={cn("grid", enter !== undefined && "auth-enter")} style={enter !== undefined ? enterDelay(enter) : undefined}>
        {children}
      </div>
    </div>
  )
}

function enterDelay(index: number): CSSProperties {
  return { animationDelay: `${500 + index * 80}ms` }
}
