import Link from "next/link"

import { Button } from "@/components/ui/button"
import { confirmExternalIdentityVerification } from "@/lib/services/external-portal-auth"

export const metadata = {
  robots: { index: false, follow: false },
}

interface VerifyPageProps {
  searchParams: Promise<{ token?: string }>
}

/**
 * Confirms an external identity's email. Confirmation is informational — it is
 * not a gate on portal access — so an expired link is a mild message, not an error.
 */
export default async function ExternalVerifyPage({ searchParams }: VerifyPageProps) {
  const { token } = await searchParams
  const confirmed = token ? await confirmExternalIdentityVerification(token) : false

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          {confirmed ? "Email confirmed" : "This link has expired"}
        </h1>
        <p className="text-sm text-muted-foreground text-balance">
          {confirmed
            ? "Thanks — builders can now see that this address is confirmed."
            : "Confirmation links last 24 hours. Nothing is blocked: your access works either way."}
        </p>
      </div>

      <Button asChild className="w-full">
        <Link href="/access">Open my workspace</Link>
      </Button>
    </div>
  )
}
