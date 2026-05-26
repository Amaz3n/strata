import { Suspense } from "react"
import { LoginForm } from "@/components/auth/login-form"
import { InviteHashHandler } from "@/components/auth/invite-hash-handler"

interface SignInPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const resolvedSearchParams = await searchParams
  const reason = typeof resolvedSearchParams?.reason === "string" ? resolvedSearchParams.reason : null
  const message = typeof resolvedSearchParams?.message === "string" ? resolvedSearchParams.message : null

  return (
    <>
      <Suspense>
        <InviteHashHandler />
      </Suspense>
      <LoginForm
        inactiveAccount={reason === "inactive-account"}
        inviteOnlySignup={reason === "invite-only"}
        routeMessage={message}
      />
    </>
  )
}
