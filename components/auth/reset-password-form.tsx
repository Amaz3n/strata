"use client"

import { useActionState } from "react"

import { updatePasswordAction, type AuthState } from "@/app/auth/actions"
import { AlertCircle } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const initialState: AuthState = {}

export function ResetPasswordForm() {
  const [state, formAction, pending] = useActionState(updatePasswordAction, initialState)

  return (
    <form action={formAction} className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="password" className="text-sm text-muted-foreground">
          New password
        </Label>
        <Input id="password" name="password" type="password" placeholder="At least 8 characters" required />
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirmPassword" className="text-sm text-muted-foreground">
          Confirm password
        </Label>
        <Input id="confirmPassword" name="confirmPassword" type="password" placeholder="Repeat your password" required />
      </div>

      {state.error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4" />
          <span>{state.error}</span>
        </div>
      )}

      <Button type="submit" className="w-full font-semibold" disabled={pending}>
        {pending ? "Updating password..." : "Update password"}
      </Button>
    </form>
  )
}
