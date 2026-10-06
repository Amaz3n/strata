import { Suspense } from "react"
import { redirect } from "next/navigation"
import AuthResetClient from "@/components/auth/auth-reset-page"

interface ResetPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

async function ResetRoute({ searchParams }: ResetPageProps) {
  const params = await searchParams
  const first = (key: string) => typeof params[key] === "string" ? params[key] : undefined
  const code = first("code")
  const tokenHash = first("token_hash")
  // Exchange one-time credentials on the server before mounting a browser
  // client, which would otherwise race its automatic PKCE URL detection.
  if (!first("external_token") && (code || tokenHash)) {
    const query = new URLSearchParams({ next: "/auth/reset" })
    if (tokenHash) {
      query.set("token_hash", tokenHash)
      query.set("type", first("type") ?? "recovery")
    } else if (code) query.set("code", code)
    redirect(`/auth/confirm?${query}`)
  }
  return <AuthResetClient />
}

export default function ResetPage(props: ResetPageProps) {
  return <Suspense fallback={<p role="status" className="py-8 text-center text-sm text-muted-foreground">Verifying your reset link...</p>}><ResetRoute {...props} /></Suspense>
}
