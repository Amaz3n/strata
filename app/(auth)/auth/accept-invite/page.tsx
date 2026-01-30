"use client"

import { useEffect, useState, Suspense } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { GalleryVerticalEnd } from "lucide-react"

import { AcceptInviteForm } from "@/components/auth/accept-invite-form"
import { Building2, Loader2, AlertCircle } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { getInviteDetailsAction } from "./actions"

function AcceptInviteContent() {
  const searchParams = useSearchParams()
  const token = searchParams.get("token")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [inviteDetails, setInviteDetails] = useState<{ orgName: string; email: string } | null>(null)

  useEffect(() => {
    if (!token) {
      setError("Invalid invitation link. Please check the link in your email.")
      setLoading(false)
      return
    }

    const fetchDetails = async () => {
      try {
        const details = await getInviteDetailsAction(token)
        if (!details) {
          setError("This invitation link has expired or is no longer valid. Please ask your admin to resend the invite.")
          setLoading(false)
          return
        }

        setInviteDetails(details)
        setLoading(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to verify your invitation.")
        setLoading(false)
      }
    }

    fetchDetails()
  }, [token])

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-6 text-center">
        <Link href="/" className="flex flex-col items-center gap-2 font-medium">
          <div className="flex size-10 items-center justify-center rounded-md bg-primary">
            <GalleryVerticalEnd className="size-6 text-primary-foreground" />
          </div>
        </Link>
        <div className="space-y-2">
          <h1 className="text-xl font-bold">Verifying your invitation</h1>
          <p className="text-muted-foreground text-sm">Please wait while we verify your invitation link.</p>
        </div>
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-6 text-center">
        <Link href="/" className="flex flex-col items-center gap-2 font-medium">
          <div className="flex size-10 items-center justify-center rounded-md bg-primary">
            <GalleryVerticalEnd className="size-6 text-primary-foreground" />
          </div>
        </Link>
        <div className="space-y-2">
          <h1 className="text-xl font-bold">Invitation not found</h1>
          <p className="text-muted-foreground text-sm max-w-xs">
            This invitation may have expired or already been used.
          </p>
        </div>
        <div className="flex w-full items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive text-left">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
        <div className="flex flex-col gap-3 w-full">
          <Button asChild variant="outline" className="w-full">
            <Link href="/auth/signin">Back to sign in</Link>
          </Button>
        </div>
      </div>
    )
  }

  if (!inviteDetails || !token) {
    return null
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <Link href="/" className="flex flex-col items-center gap-2 font-medium">
          <div className="flex size-10 items-center justify-center rounded-md bg-primary">
            <GalleryVerticalEnd className="size-6 text-primary-foreground" />
          </div>
        </Link>
        <div className="space-y-2">
          <h1 className="text-xl font-bold">Welcome to Arc</h1>
          <p className="text-muted-foreground text-sm">
            You&apos;ve been invited to join a team
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3">
        <div className="flex size-10 items-center justify-center rounded-md bg-primary/10">
          <Building2 className="size-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">{inviteDetails.orgName}</p>
          <p className="text-muted-foreground text-sm truncate">{inviteDetails.email}</p>
        </div>
      </div>

      <AcceptInviteForm token={token} orgName={inviteDetails.orgName} email={inviteDetails.email} />
    </div>
  )
}

export default function AcceptInvitePage() {
  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="w-full max-w-sm">
        <Suspense
          fallback={
            <div className="flex flex-col items-center gap-6 text-center">
              <div className="flex size-10 items-center justify-center rounded-md bg-primary">
                <GalleryVerticalEnd className="size-6 text-primary-foreground" />
              </div>
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <AcceptInviteContent />
        </Suspense>
      </div>
    </div>
  )
}
