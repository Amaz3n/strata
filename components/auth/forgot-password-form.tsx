"use client"

import { useActionState } from "react"

import { requestPasswordResetAction, type AuthState } from "@/app/(auth)/auth/actions"
import { AlertCircle, CheckCircle } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const initialState: AuthState = {}

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(requestPasswordResetAction, initialState)

  return (
    <form action={formAction} className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="email" className="text-sm text-muted-foreground">
          Work email
        </Label>
        <Input id="email" name="email" type="email" placeholder="you@company.com" required />
      </div>

      {state.error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4" />
          <span>{state.error}</span>
        </div>
      )}

      {state.message && !state.error && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          <CheckCircle className="mt-0.5 h-4 w-4" />
          <span>{state.message}</span>
        </div>
      )}

      <Button type="submit" className="w-full font-semibold" disabled={pending}>
        {pending ? "Sending reset link..." : "Send reset link"}
      </Button>
    </form>
  )
}
