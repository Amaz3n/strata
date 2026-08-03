"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { toast } from "sonner"

import { authenticateExternalPortalAccountAction } from "@/app/actions/external-portal-auth"
import { Loader2 } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export interface ExternalAuthFormProps {
  token: string
  tokenType: "portal" | "bid"
  /**
   * Resolved on the server. When true this is a sign-in (no name field, no
   * account-creation copy); when false it is a first claim. The UI never guesses.
   */
  hasExistingAccount: boolean
  initialEmail?: string
  suggestedFullName?: string
  emailLocked?: boolean
  idPrefix?: string
  onAuthenticated?: () => void
}

/**
 * The single external email/password form. Previously three components carried
 * their own copy of this, each with slightly different validation and a
 * claim/login toggle that made the visitor declare something the server knew.
 */
export function ExternalAuthForm({
  token,
  tokenType,
  hasExistingAccount,
  initialEmail = "",
  suggestedFullName = "",
  emailLocked = false,
  idPrefix = "external-auth",
  onAuthenticated,
}: ExternalAuthFormProps) {
  const router = useRouter()
  const [email, setEmail] = useState(initialEmail)
  const [fullName, setFullName] = useState(suggestedFullName)
  const [password, setPassword] = useState("")
  const [isPending, startTransition] = useTransition()

  const submit = () => {
    if (!email.trim()) {
      toast.error("Email is required")
      return
    }
    if (!hasExistingAccount && !fullName.trim()) {
      toast.error("Full name is required")
      return
    }
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters")
      return
    }

    startTransition(async () => {
      try {
        await authenticateExternalPortalAccountAction({
          token,
          token_type: tokenType,
          email,
          full_name: hasExistingAccount ? undefined : fullName,
          password,
        })
        toast.success(hasExistingAccount ? "Signed in" : "Account created")
        onAuthenticated?.()
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to continue")
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-email`}>Email</Label>
        <Input
          id={`${idPrefix}-email`}
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@company.com"
          autoComplete="email"
          disabled={emailLocked || isPending}
        />
        {emailLocked ? (
          <p className="text-xs text-muted-foreground">This invite is locked to the email above.</p>
        ) : null}
      </div>

      {!hasExistingAccount ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-name`}>Full name</Label>
          <Input
            id={`${idPrefix}-name`}
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            placeholder="Your name"
            autoComplete="name"
            disabled={isPending}
          />
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-password`}>Password</Label>
        <Input
          id={`${idPrefix}-password`}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={hasExistingAccount ? "Your Arc password" : "At least 8 characters"}
          autoComplete={hasExistingAccount ? "current-password" : "new-password"}
          disabled={isPending}
        />
      </div>

      <Button className="w-full" onClick={submit} disabled={isPending}>
        {isPending ? <Loader2 className="size-4 animate-spin" /> : null}
        {isPending ? "Please wait..." : hasExistingAccount ? "Sign in & continue" : "Create account & continue"}
        {!isPending ? <ArrowRight className="size-4" /> : null}
      </Button>

      {hasExistingAccount ? (
        <p className="text-center text-xs text-muted-foreground">
          <Link href="/auth/forgot-password" className="underline underline-offset-4 hover:text-foreground">
            Forgot password?
          </Link>
        </p>
      ) : null}
    </div>
  )
}
