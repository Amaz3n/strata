import { Suspense } from "react"
import { connection } from "next/server"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"

import { AcceptInviteForm } from "@/components/auth/accept-invite-form"
import { Building2, Loader2, AlertCircle } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { getInviteDetailsAction } from "./actions"

interface AcceptInvitePageProps {
  searchParams: Promise<{ token?: string | string[] }>
}

function InvitationLoading() {
  return (
    <div className="flex flex-col items-center gap-3 py-8" role="status">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Verifying your invitation...</p>
    </div>
  )
}

async function AcceptInviteContent({ searchParams }: AcceptInvitePageProps) {
  await connection()
  const { token: tokenParam } = await searchParams
  const token = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam
  let error: string | null = null
  let inviteDetails: Awaited<ReturnType<typeof getInviteDetailsAction>> = null

  if (!token) {
    error = "Invalid invitation link. Please check the link in your email."
  } else {
    try {
      inviteDetails = await getInviteDetailsAction(token)
      if (!inviteDetails) {
        error = "This invitation link has expired or is no longer valid. Please ask your admin to resend the invite."
      }
    } catch (err) {
      unstable_rethrow(err)
      error = err instanceof Error ? err.message : "Unable to verify your invitation."
    }
  }

  if (error) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Invitation not found</h1>
          <p className="text-sm text-muted-foreground text-balance">
            This invitation may have expired or already been used.
          </p>
        </div>

        <div className="flex items-start gap-2 border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>

        <Button asChild variant="outline" className="w-full">
          <Link href="/auth/signin">Back to sign in</Link>
        </Button>
      </div>
    )
  }

  if (!inviteDetails || !token) return null

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Join your team</h1>
        <p className="text-sm text-muted-foreground text-balance">
          You&apos;ve been invited to collaborate on Arc.
        </p>
      </div>

      <div className="flex items-center gap-3 border bg-muted/30 px-4 py-3">
        <div className="flex size-10 items-center justify-center bg-primary/10">
          <Building2 className="size-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{inviteDetails.orgName}</p>
          <p className="truncate text-sm text-muted-foreground">{inviteDetails.email}</p>
        </div>
      </div>

      <AcceptInviteForm token={token} orgName={inviteDetails.orgName} email={inviteDetails.email} />
    </div>
  )
}

export default function AcceptInvitePage({ searchParams }: AcceptInvitePageProps) {
  return (
    <Suspense fallback={<InvitationLoading />}>
      <AcceptInviteContent searchParams={searchParams} />
    </Suspense>
  )
}
