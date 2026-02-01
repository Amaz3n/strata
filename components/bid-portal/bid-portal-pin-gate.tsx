"use client"

import { useState, useTransition } from "react"
import { ShieldCheck } from "lucide-react"

import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { verifyBidPortalPinAction } from "@/app/b/[token]/actions"

interface BidPortalPinGateProps {
  token: string
  orgName: string
  projectName: string
  packageTitle: string
  onSuccess: () => void
}

export function BidPortalPinGate({
  token,
  orgName,
  projectName,
  packageTitle,
  onSuccess,
}: BidPortalPinGateProps) {
  const [pin, setPin] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleSubmit = () => {
    if (pin.length < 4) return

    setError(null)
    startTransition(async () => {
      const result = await verifyBidPortalPinAction({ token, pin })

      if (result.valid) {
        onSuccess()
      } else if (result.lockedUntil) {
        setError("Too many attempts. Please try again later.")
      } else if (result.attemptsRemaining !== undefined) {
        setError(`Incorrect PIN. ${result.attemptsRemaining} attempts remaining.`)
        setPin("")
      } else {
        setError("Incorrect PIN. Please try again.")
        setPin("")
      }
    })
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-[#0b0d11] text-white">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 p-8 shadow-[0_20px_80px_rgba(0,0,0,0.4)]">
        <div className="flex items-center gap-3 text-xs uppercase tracking-[0.35em] text-white/60">
          <ShieldCheck className="h-4 w-4 text-emerald-300/80" />
          {orgName}
        </div>
        <h1 className="mt-4 text-2xl font-semibold font-serif">{packageTitle}</h1>
        <p className="text-sm text-white/60">{projectName}</p>

        <div className="mt-8 space-y-4">
          <p className="text-sm text-white/70">Enter your PIN to view the bid package.</p>
          <div className="flex justify-center">
            <InputOTP
              maxLength={6}
              value={pin}
              onChange={setPin}
              onComplete={handleSubmit}
              disabled={isPending}
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

          {error && <p className="text-sm text-rose-200 text-center">{error}</p>}

          <Button
            onClick={handleSubmit}
            disabled={pin.length < 4 || isPending}
            className="w-full bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
          >
            {isPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
            Continue
          </Button>
        </div>
      </div>
    </div>
  )
}
