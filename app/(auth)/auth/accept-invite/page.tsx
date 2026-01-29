"use client"

import { useEffect, useState, Suspense } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"

import { AcceptInviteForm } from "@/components/auth/accept-invite-form"
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
      <div className="space-y-4 text-center">
        <p className="text-sm uppercase tracking-[0.2em] text-white/60">Accept invitation</p>
        <h2 className="text-2xl font-semibold text-white">Verifying your invitation</h2>
        <p className="text-sm text-white/60">Please wait while we verify your invitation link.</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-4">
        <div>
          <p className="text-sm uppercase tracking-[0.2em] text-white/60">Accept invitation</p>
          <h2 className="mt-2 text-2xl font-semibold text-white">Invalid or expired invitation</h2>
          <p className="text-sm text-white/60">Please contact your admin for a new invitation.</p>
        </div>
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
        <div className="text-sm text-white/60">
          <Link href="/auth/signin" className="underline">
            Back to sign in
          </Link>
        </div>
      </div>
    )
  }

  if (!inviteDetails || !token) {
    return null
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm uppercase tracking-[0.2em] text-white/60">Accept invitation</p>
        <h2 className="mt-2 text-2xl font-semibold text-white">
          Join <span className="text-primary">{inviteDetails.orgName}</span>
        </h2>
        <p className="text-sm text-white/60">Complete your account setup to get started.</p>
      </div>
      <AcceptInviteForm token={token} orgName={inviteDetails.orgName} email={inviteDetails.email} />
    </div>
  )
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<div className="text-white">Loading...</div>}>
      <AcceptInviteContent />
    </Suspense>
  )
}
