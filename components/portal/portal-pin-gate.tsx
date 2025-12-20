"use client"

import { useState, useTransition } from "react"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { verifyPortalPinAction } from "@/app/p/[token]/actions"

interface PortalPinGateProps {
  token: string
  projectName: string
  orgName: string
  onSuccess: () => void
}

export function PortalPinGate({ token, projectName, orgName, onSuccess }: PortalPinGateProps) {
  const [pin, setPin] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleSubmit = () => {
    if (pin.length < 4) return

    setError(null)
    startTransition(async () => {
      const result = await verifyPortalPinAction({ token, pin })

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
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-b from-background to-muted">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <p className="text-xs text-muted-foreground mb-1">{orgName}</p>
          <CardTitle>{projectName}</CardTitle>
          <CardDescription>Enter your PIN to access the portal</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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

          {error && (
            <p className="text-sm text-destructive text-center">{error}</p>
          )}

          <Button
            onClick={handleSubmit}
            disabled={pin.length < 4 || isPending}
            className="w-full"
          >
            {isPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
            Continue
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
