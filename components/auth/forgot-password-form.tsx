"use client"

import Link from "next/link"
import { useActionState } from "react"
import { ArrowLeft } from "lucide-react"

import { requestPasswordResetAction, type AuthState } from "@/app/(auth)/auth/actions"
import { AlertCircle, CheckCircle, Loader2 } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const initialState: AuthState = { error: undefined, message: undefined, mfaRequired: undefined }

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(requestPasswordResetAction, initialState)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
        <p className="text-sm text-muted-foreground text-balance">
          Enter your email and we&apos;ll send you a link to reset your password.
        </p>
      </div>

      <form action={formAction} className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" placeholder="you@company.com" autoComplete="email" required />
        </div>

        {state.error && (
          <div className="flex items-start gap-2 border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{state.error}</span>
          </div>
        )}

        {state.message && !state.error && (
          <div className="flex items-start gap-2 border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle className="mt-0.5 size-4 shrink-0" />
            <span>{state.message}</span>
          </div>
        )}

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Sending link...
            </>
          ) : (
            "Send reset link"
          )}
        </Button>
      </form>

      <div className="text-center">
        <Link
          href="/auth/signin"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          <ArrowLeft className="size-3.5" />
          Back to sign in
        </Link>
      </div>
    </div>
  )
}
