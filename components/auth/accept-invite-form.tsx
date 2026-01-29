"use client"

import { useActionState } from "react"

import { acceptInviteAction, type AcceptInviteState } from "@/app/(auth)/auth/accept-invite/actions"
import { AlertCircle } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

interface AcceptInviteFormProps {
  token: string
  orgName: string
  email: string
}

const initialState: AcceptInviteState = {}

export function AcceptInviteForm({ token, orgName, email }: AcceptInviteFormProps) {
  const [state, formAction, pending] = useActionState(acceptInviteAction, initialState)

  return (
    <form action={formAction}>
      <input type="hidden" name="token" value={token} />
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            value={email}
            disabled
            className="bg-white/5"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="fullName">Full name</FieldLabel>
          <Input
            id="fullName"
            name="fullName"
            type="text"
            placeholder="Enter your full name"
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            placeholder="At least 8 characters"
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="confirmPassword">Confirm password</FieldLabel>
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            placeholder="Repeat your password"
            required
          />
        </Field>
        {state.error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4" />
            <span>{state.error}</span>
          </div>
        )}
        <Field>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Joining..." : `Join ${orgName}`}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
