"use client"

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"

import { AlertCircle, CheckCircle, Lock, ShieldCheck } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Spinner } from "@/components/ui/spinner"
import { createClient } from "@/lib/supabase/client"

type EnrolledTotpFactor = {
  id: string
  friendlyName: string
}

type PendingEnrollment = {
  id: string
  qrCode: string
  secret: string
}

function resolveQrImageSrc(rawQrCode: string) {
  const value = rawQrCode.trim()
  if (!value) return ""
  if (value.startsWith("data:image")) return value
  if (value.startsWith("<svg")) return `data:image/svg+xml;utf8,${encodeURIComponent(value)}`
  return value
}

export function MfaSettingsCard() {
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [factor, setFactor] = useState<EnrolledTotpFactor | null>(null)
  const [pendingEnrollment, setPendingEnrollment] = useState<PendingEnrollment | null>(null)
  const [otpCode, setOtpCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refreshFactor = useCallback(() => {
    setLoading(true)
    setError(null)
    supabase.auth.mfa.listFactors()
      .then(({ data, error: factorsError }) => {
        if (factorsError) {
          throw factorsError
        }
        const verified = data.totp.find((existingFactor) => existingFactor.status === "verified")
        setFactor(
          verified
            ? {
                id: verified.id,
                friendlyName: verified.friendly_name ?? "Authenticator app",
              }
            : null,
        )
      })
      .catch((refreshError) => setError(refreshError.message))
      .finally(() => setLoading(false))
  }, [supabase.auth.mfa])

  useEffect(() => {
    refreshFactor()
  }, [refreshFactor])

  const startSetup = () => {
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors()
      if (factorsError) {
        setError(factorsError.message)
        return
      }

      const existingUnverifiedTotp = factorsData.all.filter(
        (existingFactor) => existingFactor.factor_type === "totp" && existingFactor.status === "unverified",
      )

      for (const existingFactor of existingUnverifiedTotp) {
        await supabase.auth.mfa.unenroll({ factorId: existingFactor.id })
      }

      const { data: enrollData, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        issuer: "Arc",
        friendlyName: "Arc Authenticator",
      })

      if (enrollError) {
        setError(enrollError.message)
        return
      }

      setPendingEnrollment({
        id: enrollData.id,
        qrCode: enrollData.totp.qr_code,
        secret: enrollData.totp.secret,
      })
      setOtpCode("")
      setNotice("Scan the QR code, then enter the 6-digit code to finish setup.")
    })
  }

  const verifySetup = () => {
    if (!pendingEnrollment || otpCode.length !== 6) return
    setError(null)
    setNotice(null)

    startTransition(async () => {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: pendingEnrollment.id,
        code: otpCode,
      })

      if (verifyError) {
        setError(verifyError.message)
        setOtpCode("")
        return
      }

      setPendingEnrollment(null)
      setOtpCode("")
      setNotice("Two-factor authentication is now enabled.")
      refreshFactor()
    })
  }

  const cancelSetup = () => {
    if (!pendingEnrollment) return
    setError(null)
    setNotice(null)
    startTransition(async () => {
      await supabase.auth.mfa.unenroll({ factorId: pendingEnrollment.id })
      setPendingEnrollment(null)
      setOtpCode("")
    })
  }

  const disableMfa = () => {
    if (!factor) return
    const confirmed = window.confirm("Turn off 2FA for your account?")
    if (!confirmed) return

    setError(null)
    setNotice(null)
    startTransition(async () => {
      const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId: factor.id })
      if (unenrollError) {
        setError(unenrollError.message)
        return
      }

      setFactor(null)
      setNotice("Two-factor authentication has been disabled.")
    })
  }

  return (
    <Card className="border-border/80 bg-background/75">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">Two-factor authentication</CardTitle>
          <CardDescription>Protect your account with an authenticator app code.</CardDescription>
        </div>
        <Badge variant={factor ? "default" : "outline"} className={factor ? "bg-success text-success-foreground" : ""}>
          <Lock className="mr-1 h-3.5 w-3.5" />
          {factor ? "Enabled" : "Disabled"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Checking 2FA status...
          </div>
        ) : factor ? (
          <div className="space-y-3">
            <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4" />
                <span>{factor.friendlyName} is active.</span>
              </div>
            </div>
            <Button type="button" variant="outline" onClick={disableMfa} disabled={isPending}>
              Disable 2FA
            </Button>
          </div>
        ) : pendingEnrollment ? (
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/20 p-4">
              <div className="mx-auto w-fit rounded-md border bg-white p-3">
                <img
                  src={resolveQrImageSrc(pendingEnrollment.qrCode)}
                  alt="QR code for authenticator setup"
                  className="h-44 w-44"
                />
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Can&apos;t scan? Enter this code in your authenticator app.
              </p>
              <div className="mt-2 flex gap-2">
                <Input value={pendingEnrollment.secret} readOnly className="font-mono text-xs" />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => navigator.clipboard.writeText(pendingEnrollment.secret)}
                >
                  Copy
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">Enter 6-digit code</p>
              <InputOTP maxLength={6} value={otpCode} onChange={setOtpCode} onComplete={verifySetup}>
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

            <div className="flex gap-2">
              <Button type="button" onClick={verifySetup} disabled={otpCode.length !== 6 || isPending}>
                {isPending ? "Verifying..." : "Verify and enable"}
              </Button>
              <Button type="button" variant="ghost" onClick={cancelSetup} disabled={isPending}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button type="button" onClick={startSetup} disabled={isPending}>
            Enable 2FA with OTP
          </Button>
        )}

        {(error || notice) && (
          <div
            className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
              error
                ? "border-destructive/30 bg-destructive/5 text-destructive"
                : "border-success/30 bg-success/10 text-success"
            }`}
          >
            {error ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{error ?? notice}</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
