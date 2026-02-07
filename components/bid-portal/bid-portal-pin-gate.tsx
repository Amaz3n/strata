"use client"

import { useState, useTransition } from "react"
import { ShieldCheck } from "lucide-react"

import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Card, CardContent } from "@/components/ui/card"
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
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <Card className="w-full max-w-md">
        <CardContent className="p-8">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="h-4 w-4" />
            {orgName}
          </div>
          <h1 className="mt-4 text-2xl font-semibold">{packageTitle}</h1>
          <p className="text-sm text-muted-foreground">{projectName}</p>

          <div className="mt-8 space-y-4">
            <p className="text-sm text-muted-foreground">Enter your PIN to view the bid package.</p>
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

            {error && <p className="text-sm text-destructive text-center">{error}</p>}

            <Button
              onClick={handleSubmit}
              disabled={pin.length < 4 || isPending}
              className="w-full"
            >
              {isPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
              Continue
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
