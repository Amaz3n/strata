import { Suspense } from "react"
import { LoginForm } from "@/components/auth/login-form"
import { InviteHashHandler } from "@/components/auth/invite-hash-handler"
import { normalizeInternalReturnPath } from "@/lib/auth/return-path"

interface SignInPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const resolvedSearchParams = await searchParams
  const reason = typeof resolvedSearchParams?.reason === "string" ? resolvedSearchParams.reason : null
  const message = typeof resolvedSearchParams?.message === "string" ? resolvedSearchParams.message : null
  const next = normalizeInternalReturnPath(resolvedSearchParams?.next)

  return (
    <>
      <Suspense>
        <InviteHashHandler />
      </Suspense>
      <LoginForm
        inactiveAccount={reason === "inactive-account"}
        inviteOnlySignup={reason === "invite-only"}
        routeMessage={message}
        returnTo={next}
      />
    </>
  )
}
