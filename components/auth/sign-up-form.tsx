"use client"

import Link from "next/link"
import { useActionState } from "react"

import { signUpAction, type AuthState } from "@/app/auth/actions"
import { AlertCircle, CheckCircle } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const initialState: AuthState = {}

export function SignUpForm() {
  const [state, formAction, pending] = useActionState(signUpAction, initialState)

  return (
    <form action={formAction} className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="fullName" className="text-sm text-muted-foreground">
            Full name
          </Label>
          <Input id="fullName" name="fullName" placeholder="Jordan Lee" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="orgName" className="text-sm text-muted-foreground">
            Company / org
          </Label>
          <Input id="orgName" name="orgName" placeholder="Strata Builders" required />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="email" className="text-sm text-muted-foreground">
          Work email
        </Label>
        <Input id="email" name="email" type="email" placeholder="you@company.com" required />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password" className="text-sm text-muted-foreground">
          Password
        </Label>
        <Input id="password" name="password" type="password" placeholder="At least 8 characters" required />
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
        {pending ? "Creating account..." : "Create account"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        Already onboard?{" "}
        <Link href="/auth/signin" className="text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  )
}
