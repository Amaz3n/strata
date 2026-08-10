"use client"

import { useActionState } from "react"
import Link from "next/link"

import { completeExternalPasswordResetAction, type AuthState } from "@/app/(auth)/auth/actions"
import { AlertCircle, Loader2 } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface ExternalResetPasswordFormProps {
  token: string
}

const initialState: AuthState = {}

/**
 * Completion form for an external identity's reset. The Supabase branch of this
 * page updates a live auth session; an external identity has no Supabase session,
 * so the raw token travels with the form and the server verifies it.
 */
export function ExternalResetPasswordForm({ token }: ExternalResetPasswordFormProps) {
  const [state, formAction, pending] = useActionState(completeExternalPasswordResetAction, initialState)

  if (state.message) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{state.message}</p>
        <Button asChild className="w-full">
          <Link href="/auth/signin">Sign in</Link>
        </Button>
      </div>
    )
  }

  return (
    <form action={formAction} className="grid gap-4">
      <input type="hidden" name="token" value={token} />

      <div className="grid gap-2">
        <Label htmlFor="external-password">New password</Label>
        <Input
          id="external-password"
          name="password"
          type="password"
          placeholder="At least 8 characters"
          autoComplete="new-password"
          required
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="external-confirm-password">Confirm password</Label>
        <Input
          id="external-confirm-password"
          name="confirmPassword"
          type="password"
          placeholder="Repeat your password"
          autoComplete="new-password"
          required
        />
      </div>

      {state.error && (
        <div className="flex items-start gap-2 border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{state.error}</span>
        </div>
      )}

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Updating password...
          </>
        ) : (
          "Update password"
        )}
      </Button>
    </form>
  )
}
