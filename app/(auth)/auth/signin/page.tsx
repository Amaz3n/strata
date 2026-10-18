import { Suspense } from "react"
import { LoginForm } from "@/components/auth/login-form"
import { InviteHashHandler } from "@/components/auth/invite-hash-handler"
import { AuthFormSkeleton } from "@/components/auth/auth-form-skeleton"
import { normalizeInternalReturnPath } from "@/lib/auth/return-path"

interface SignInPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

export default function SignInPage({ searchParams }: SignInPageProps) {
  return (
    <>
      <Suspense>
        <InviteHashHandler />
      </Suspense>
      <Suspense fallback={<AuthFormSkeleton />}>
        <SignInRouteContent searchParams={searchParams} />
      </Suspense>
    </>
  )
}

async function SignInRouteContent({ searchParams }: SignInPageProps) {
  const resolvedSearchParams = await searchParams
  const reason = typeof resolvedSearchParams?.reason === "string" ? resolvedSearchParams.reason : null
  const message = typeof resolvedSearchParams?.message === "string" ? resolvedSearchParams.message : null
  const next = normalizeInternalReturnPath(resolvedSearchParams?.next)

  return (
    <LoginForm
      inactiveAccount={reason === "inactive-account"}
      inviteOnlySignup={reason === "invite-only"}
      routeMessage={message}
      returnTo={next}
    />
  )
}
