"use client"

import Link from "next/link"
import { useActionState } from "react"

import { signUpAction, type AuthState } from "@/app/(auth)/auth/actions"
import { AlertCircle, CheckCircle, Loader2 } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const initialState: AuthState = { error: undefined, message: undefined, mfaRequired: undefined }

export function SignUpForm() {
  const [state, formAction, pending] = useActionState(signUpAction, initialState)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Create your workspace</h1>
        <p className="text-sm text-muted-foreground text-balance">
          Set up your organization and start managing projects.
        </p>
      </div>

      <form action={formAction} className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="fullName">Full name</Label>
            <Input id="fullName" name="fullName" placeholder="Jordan Lee" autoComplete="name" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="orgName">Company / org</Label>
            <Input id="orgName" name="orgName" placeholder="Arc Builders" required />
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="email">Work email</Label>
          <Input id="email" name="email" type="email" placeholder="you@company.com" autoComplete="email" required />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            placeholder="At least 8 characters"
            autoComplete="new-password"
            required
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="inviteCode">Invite code</Label>
          <Input id="inviteCode" name="inviteCode" placeholder="Enter invite code" />
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
              Creating account...
            </>
          ) : (
            "Create account"
          )}
        </Button>
      </form>

      <div className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/auth/signin" className="text-foreground underline-offset-4 hover:underline">
          Sign in
        </Link>
      </div>
    </div>
  )
}
