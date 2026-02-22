"use client"

import { useState, useActionState } from "react"
import Link from "next/link"

import { acceptInviteAction, type AcceptInviteState } from "@/app/(auth)/auth/accept-invite/actions"
import { AlertCircle, Check, X } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

interface AcceptInviteFormProps {
  token: string
  orgName: string
  email: string
}

interface PasswordRequirement {
  label: string
  test: (password: string) => boolean
}

const passwordRequirements: PasswordRequirement[] = [
  { label: "At least 8 characters", test: (p) => p.length >= 8 },
  { label: "One uppercase letter", test: (p) => /[A-Z]/.test(p) },
  { label: "One lowercase letter", test: (p) => /[a-z]/.test(p) },
  { label: "One number", test: (p) => /[0-9]/.test(p) },
]

const initialState: AcceptInviteState = { error: undefined }

export function AcceptInviteForm({ token, orgName, email }: AcceptInviteFormProps) {
  const [state, formAction, pending] = useActionState(acceptInviteAction, initialState)
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showRequirements, setShowRequirements] = useState(false)

  const allRequirementsMet = passwordRequirements.every((req) => req.test(password))
  const passwordsMatch = password.length > 0 && confirmPassword.length > 0 && password === confirmPassword
  const passwordsDontMatch = confirmPassword.length > 0 && password !== confirmPassword
  const canSubmit = allRequirementsMet && passwordsMatch

  return (
    <form action={formAction}>
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="email" value={email} />
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="fullName">Your name</FieldLabel>
          <Input
            id="fullName"
            name="fullName"
            type="text"
            placeholder="Enter your full name"
            autoComplete="name"
            autoFocus
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Create a password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            placeholder="Create a strong password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onFocus={() => setShowRequirements(true)}
            required
          />
          {showRequirements && (
            <div className="mt-2 space-y-1.5">
              {passwordRequirements.map((req) => {
                const met = req.test(password)
                return (
                  <div
                    key={req.label}
                    className={cn(
                      "flex items-center gap-2 text-xs transition-colors",
                      met ? "text-emerald-600 dark:text-emerald-500" : "text-muted-foreground"
                    )}
                  >
                    {met ? (
                      <Check className="size-3.5" />
                    ) : (
                      <X className="size-3.5" />
                    )}
                    <span>{req.label}</span>
                  </div>
                )
              })}
            </div>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor="confirmPassword">Confirm password</FieldLabel>
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            placeholder="Repeat your password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className={cn(
              passwordsDontMatch && "border-destructive focus-visible:ring-destructive"
            )}
            required
          />
          {passwordsDontMatch && (
            <p className="mt-1.5 text-xs text-destructive">Passwords don&apos;t match</p>
          )}
          {passwordsMatch && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-500">
              <Check className="size-3.5" />
              Passwords match
            </p>
          )}
        </Field>
        {state.error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{state.error}</span>
          </div>
        )}
        <Field>
          <Button type="submit" className="w-full" disabled={pending || !canSubmit}>
            {pending ? "Setting up your account..." : `Join ${orgName}`}
          </Button>
        </Field>
      </FieldGroup>
      <FieldDescription className="mt-6 px-2 text-center">
        Already have an account?{" "}
        <Link href="/auth/signin" className="underline">
          Sign in
        </Link>
      </FieldDescription>
    </form>
  )
}
