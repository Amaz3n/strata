import Link from "next/link"
import { redirect } from "next/navigation"

import { ExternalPortalSignOutButton } from "@/components/portal/external-portal-sign-out-button"
import { Button } from "@/components/ui/button"
import { getExternalPortalWorkspaceContext } from "@/lib/services/external-portal-auth"

export const revalidate = 0
export const metadata = {
  robots: { index: false, follow: false },
}

/**
 * The one stable, token-free URL for external accounts: the bookmark target, the
 * link in emails, and where sign-in lands. It is a router, not a hub — the portal
 * shell's own switcher is the only place anyone chooses between workspaces, so a
 * second full-page chooser here was just a screen to click through.
 */
export default async function ExternalAccessPage() {
  const workspace = await getExternalPortalWorkspaceContext()

  if (!workspace) {
    redirect("/auth/signin")
  }

  const mostRecent = [...workspace.items].sort((a, b) => {
    const aSeen = a.last_accessed_at ? Date.parse(a.last_accessed_at) : 0
    const bSeen = b.last_accessed_at ? Date.parse(b.last_accessed_at) : 0
    return bSeen - aSeen
  })[0]

  if (mostRecent) {
    redirect(mostRecent.href)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md space-y-6 border border-border bg-card p-6 sm:p-8">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold tracking-tight">No active workspaces</h1>
          <p className="text-sm leading-6 text-muted-foreground">
            You are signed in as {workspace.identity.full_name || workspace.identity.email}, but no
            builder currently shares a project or bid with you. Ask them to send a new invite — it
            will open here automatically.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/auth/signin">Use a different account</Link>
          </Button>
          <ExternalPortalSignOutButton />
        </div>
      </div>
    </div>
  )
}
