"use client"

import Link from "next/link"
import { useActionState, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { GalleryVerticalEnd } from "lucide-react"

import { signInAction, type AuthState } from "@/app/(auth)/auth/actions"
import { AlertCircle, Loader2, ShieldCheck } from "@/components/icons"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"

const initialState: AuthState = { error: undefined, message: undefined, mfaRequired: undefined }

export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const router = useRouter()
  const [state, formAction, pending] = useActionState(signInAction, initialState)
  const [isTransitioningToMfa, setIsTransitioningToMfa] = useState(false)
  const searchParams = useSearchParams()
  const inactiveAccount = searchParams.get("reason") === "inactive-account"
  const displayError =
    state.error ??
    (inactiveAccount ? "This account has been archived. Contact your organization admin to restore access." : null)

  useEffect(() => {
    if (!state.mfaRequired) return

    setIsTransitioningToMfa(true)
    const timer = window.setTimeout(() => {
      router.push("/auth/mfa")
      router.refresh()
    }, 520)

    return () => window.clearTimeout(timer)
  }, [router, state.mfaRequired])

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <div className="relative min-h-[360px] overflow-hidden">
        <div
          className={cn(
            "transition-all duration-500 ease-out",
            isTransitioningToMfa ? "-translate-x-8 opacity-0" : "translate-x-0 opacity-100",
          )}
        >
          <form action={formAction}>
            <FieldGroup>
              <div className="flex flex-col items-center gap-2 text-center">
                <Link
                  href="/"
                  className="flex flex-col items-center gap-2 font-medium"
                >
                  <div className="flex size-8 items-center justify-center rounded-md bg-primary">
                    <GalleryVerticalEnd className="size-6 text-primary-foreground" />
                  </div>
                  <span className="sr-only">Arc</span>
                </Link>
                <h1 className="text-xl font-bold">Sign in</h1>
              </div>
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="you@company.com"
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  placeholder="••••••••"
                  required
                />
                <div className="flex justify-end">
                  <Link href="/auth/forgot-password" className="text-xs underline">
                    Forgot password?
                  </Link>
                </div>
              </Field>
              {displayError && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4" />
                  <span>{displayError}</span>
                </div>
              )}
              <Field>
                <Button type="submit" className="w-full" disabled={pending || isTransitioningToMfa}>
                  {pending ? "Signing in..." : "Sign in"}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </div>

        <div
          aria-hidden={!isTransitioningToMfa}
          className={cn(
            "absolute inset-0 flex items-center justify-center transition-all duration-500 ease-out",
            isTransitioningToMfa ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0 pointer-events-none",
          )}
        >
          <div className="w-full rounded-lg border bg-card p-6 text-center">
            <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <p className="text-base font-semibold">Password verified</p>
            <p className="mt-1 text-sm text-muted-foreground">Continuing to two-factor verification...</p>
            <div className="mt-4 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Preparing secure check</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
