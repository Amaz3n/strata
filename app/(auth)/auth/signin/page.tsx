import { Suspense } from "react"
import { LoginForm } from "@/components/auth/login-form"
import { InviteHashHandler } from "@/components/auth/invite-hash-handler"
import { normalizeInternalReturnPath } from "@/lib/auth/return-path"
import { Skeleton } from "@/components/ui/skeleton"

interface SignInPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

export default function SignInPage({ searchParams }: SignInPageProps) {
  return (
    <>
      <Suspense>
        <InviteHashHandler />
      </Suspense>
      <Suspense fallback={<SignInShell />}>
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

function SignInShell() {
  return (
    <div className="mx-auto grid w-full max-w-sm gap-6" aria-busy="true">
      <div className="grid gap-2 text-center">
        <Skeleton className="mx-auto h-8 w-48" />
        <Skeleton className="mx-auto h-4 w-64" />
      </div>
      <div className="grid gap-4">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    </div>
  )
}
