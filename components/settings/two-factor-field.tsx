"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { toast } from "sonner"

import { ArrowLeft, Check, Copy, ShieldCheck, Smartphone } from "@/components/icons"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { SettingsError, SettingsField } from "@/components/settings/settings-section"
import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"

type EnrolledFactor = {
  id: string
  friendlyName: string
}

type PendingEnrollment = {
  id: string
  qrCode: string
  secret: string
}

type SetupStep = "scan" | "verify"

function resolveQrImageSrc(rawQrCode: string) {
  const value = rawQrCode.trim()
  if (!value) return ""
  if (value.startsWith("data:image")) return value
  if (value.startsWith("<svg")) return `data:image/svg+xml;utf8,${encodeURIComponent(value)}`
  return value
}

function Stepper({ step }: { step: SetupStep }) {
  const steps: { key: SetupStep; label: string }[] = [
    { key: "scan", label: "Scan" },
    { key: "verify", label: "Verify" },
  ]
  const activeIndex = steps.findIndex((entry) => entry.key === step)

  return (
    <ol className="flex items-center gap-2" aria-label="Setup progress">
      {steps.map((entry, index) => {
        const state = index < activeIndex ? "done" : index === activeIndex ? "active" : "upcoming"
        return (
          <li key={entry.key} className="flex items-center gap-2">
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center border text-[11px] font-semibold tabular-nums",
                state === "done" && "border-success/40 bg-success/10 text-success",
                state === "active" && "border-primary bg-primary text-primary-foreground",
                state === "upcoming" && "border-border text-muted-foreground",
              )}
            >
              {state === "done" ? <Check className="size-3" /> : index + 1}
            </span>
            <span
              className={cn(
                "text-xs font-medium",
                state === "upcoming" ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {entry.label}
            </span>
            {index < steps.length - 1 ? <span aria-hidden className="ml-1 h-px w-6 bg-border" /> : null}
          </li>
        )
      })}
    </ol>
  )
}

export function TwoFactorField() {
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(true)
  const [factor, setFactor] = useState<EnrolledFactor | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [setupOpen, setSetupOpen] = useState(false)
  const [step, setStep] = useState<SetupStep>("scan")
  const [pending, setPending] = useState<PendingEnrollment | null>(null)
  const [otp, setOtp] = useState("")
  const [setupError, setSetupError] = useState<string | null>(null)
  const [secretCopied, setSecretCopied] = useState(false)
  const [isPending, startTransition] = useTransition()

  const [confirmDisable, setConfirmDisable] = useState(false)
  const [disabling, setDisabling] = useState(false)
  // Set when the dialog is dismissed while the initial enroll round-trip is still in flight,
  // so the factor it creates can be torn down instead of orphaned on the server.
  const cancelledRef = useRef(false)

  const refresh = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    supabase.auth.mfa
      .listFactors()
      .then(({ data, error }) => {
        if (error) throw error
        const verified = data.totp.find((existing) => existing.status === "verified")
        setFactor(verified ? { id: verified.id, friendlyName: verified.friendly_name ?? "Authenticator app" } : null)
      })
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "Unable to check 2FA status."))
      .finally(() => setLoading(false))
  }, [supabase.auth.mfa])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!secretCopied) return
    const timer = window.setTimeout(() => setSecretCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [secretCopied])

  const beginEnrollment = useCallback(() => {
    setSetupError(null)
    startTransition(async () => {
      const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors()
      if (factorsError) {
        setSetupError(factorsError.message)
        return
      }

      // Clear abandoned enrollments so a retry never trips the duplicate-factor error.
      const stale = factorsData.all.filter(
        (existing) => existing.factor_type === "totp" && existing.status === "unverified",
      )
      for (const entry of stale) {
        await supabase.auth.mfa.unenroll({ factorId: entry.id })
      }

      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        issuer: "Arc",
        friendlyName: "Arc Authenticator",
      })

      if (error) {
        setSetupError(error.message)
        return
      }

      if (cancelledRef.current) {
        // The dialog closed before enroll resolved — discard the factor instead of showing it.
        void supabase.auth.mfa.unenroll({ factorId: data.id })
        return
      }

      setPending({ id: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret })
    })
  }, [supabase.auth.mfa])

  const openSetup = () => {
    cancelledRef.current = false
    setStep("scan")
    setOtp("")
    setSetupError(null)
    setPending(null)
    setSetupOpen(true)
    beginEnrollment()
  }

  const closeSetup = (nextOpen: boolean) => {
    if (nextOpen) return
    // Mark cancelled so an enroll still in flight tears its factor down when it resolves.
    cancelledRef.current = true
    setSetupOpen(false)
    // Drop the half-finished factor so the next attempt starts clean.
    const abandoned = pending
    setPending(null)
    setOtp("")
    setStep("scan")
    setSetupError(null)
    if (abandoned) {
      void supabase.auth.mfa.unenroll({ factorId: abandoned.id })
    }
  }

  const verify = () => {
    if (!pending || otp.length !== 6) return
    setSetupError(null)
    startTransition(async () => {
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: pending.id, code: otp })
      if (error) {
        setSetupError(error.message)
        setOtp("")
        return
      }

      setSetupOpen(false)
      setPending(null)
      setOtp("")
      setStep("scan")
      toast.success("Two-factor authentication enabled")
      refresh()
    })
  }

  const disable = () => {
    if (!factor) return
    setDisabling(true)
    startTransition(async () => {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id })
      setDisabling(false)
      setConfirmDisable(false)
      if (error) {
        setLoadError(error.message)
        return
      }
      setFactor(null)
      toast.success("Two-factor authentication disabled")
    })
  }

  return (
    <SettingsField
      label="Two-factor authentication"
      hint="Add a one-time code from your phone on top of your password."
    >
      {loading ? (
        <Skeleton className="h-8 w-40 rounded-none" />
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {factor ? (
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm text-foreground">
                  <ShieldCheck className="size-4 shrink-0 text-success" />
                  Enabled
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{factor.friendlyName}</p>
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">Not enabled</span>
            )}
            {factor ? (
              <Button size="sm" variant="outline" onClick={() => setConfirmDisable(true)} disabled={isPending}>
                Turn off
              </Button>
            ) : (
              <Button size="sm" onClick={openSetup} disabled={isPending}>
                Set up
              </Button>
            )}
          </div>

          {loadError ? <SettingsError>{loadError}</SettingsError> : null}
        </div>
      )}

      <Dialog open={setupOpen} onOpenChange={closeSetup}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set up two-factor authentication</DialogTitle>
            <DialogDescription>
              Use an authenticator app like 1Password, Google Authenticator, or Authy.
            </DialogDescription>
          </DialogHeader>

          <div className="border-y border-border py-3">
            <Stepper step={step} />
          </div>

          {!pending ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              {setupError ? (
                <div className="space-y-3 text-center">
                  <SettingsError className="justify-center">{setupError}</SettingsError>
                  <Button variant="outline" size="sm" onClick={beginEnrollment} disabled={isPending}>
                    Try again
                  </Button>
                </div>
              ) : (
                <>
                  <Spinner className="size-4" />
                  Preparing your setup key…
                </>
              )}
            </div>
          ) : step === "scan" ? (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                {/* Literal white: a QR needs a light quiet zone to scan, in dark mode too. */}
                <div className="w-fit shrink-0 border border-border bg-white p-2">
                  <img src={resolveQrImageSrc(pending.qrCode)} alt="QR code for authenticator setup" className="size-36" />
                </div>
                <div className="min-w-0 flex-1 space-y-3">
                  <p className="text-sm leading-5 text-muted-foreground">
                    Scan this with your authenticator app. Can&rsquo;t scan? Enter the key by hand instead.
                  </p>
                  <div className="space-y-1.5">
                    <p className="microlabel">Setup key</p>
                    <div className="flex items-center gap-2">
                      <Input
                        value={pending.secret}
                        readOnly
                        aria-label="Two-factor setup key"
                        className="h-8 font-mono text-xs"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        aria-label="Copy setup key"
                        title="Copy setup key"
                        onClick={() => {
                          void navigator.clipboard.writeText(pending.secret)
                          setSecretCopied(true)
                        }}
                      >
                        {secretCopied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
              {setupError ? <SettingsError>{setupError}</SettingsError> : null}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-3 border border-border bg-muted/20 p-3">
                <Smartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <p className="text-sm leading-5 text-muted-foreground">
                  Enter the 6-digit code your authenticator app shows for <span className="text-foreground">Arc</span>.
                </p>
              </div>
              <div className="space-y-1.5">
                <p className="microlabel">Verification code</p>
                <InputOTP
                  maxLength={6}
                  value={otp}
                  onChange={setOtp}
                  onComplete={verify}
                  autoFocus
                  disabled={isPending}
                  aria-label="Verification code"
                >
                  <InputOTPGroup>
                    {[0, 1, 2, 3, 4, 5].map((index) => (
                      <InputOTPSlot key={index} index={index} />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
              </div>
              {setupError ? <SettingsError>{setupError}</SettingsError> : null}
            </div>
          )}

          <DialogFooter className="sm:justify-between">
            {step === "verify" ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setStep("scan")
                  setOtp("")
                  setSetupError(null)
                }}
                disabled={isPending}
                className="sm:mr-auto"
              >
                <ArrowLeft className="size-4" />
                Back
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => closeSetup(false)} disabled={isPending}>
                Cancel
              </Button>
            )}
            {step === "scan" ? (
              <Button onClick={() => setStep("verify")} disabled={!pending || isPending}>
                Continue
              </Button>
            ) : (
              <Button onClick={verify} disabled={otp.length !== 6 || isPending}>
                {isPending ? "Verifying…" : "Verify and enable"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDisable} onOpenChange={setConfirmDisable}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off two-factor authentication?</AlertDialogTitle>
            <AlertDialogDescription>
              Your account will be protected by your password alone. You can set it up again at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disabling}>Keep it on</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                disable()
              }}
              disabled={disabling}
            >
              {disabling ? "Turning off…" : "Turn off"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsField>
  )
}
