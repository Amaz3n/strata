import type { ReactNode } from "react"

import { PortalBrandHeader, type PortalIdentity } from "./portal-brand-header"
import { PortalBottomNav, PortalSideNav } from "./portal-nav"
import type { PortalNavItem } from "./portal-nav-items"
import type { ExternalPortalWorkspaceContext } from "@/lib/types"

interface PortalShellProps {
  identity: PortalIdentity
  /** Portal root, e.g. `/s/abc123`. Nav segments are appended to it. */
  root: string
  nav: PortalNavItem[]
  workspace?: ExternalPortalWorkspaceContext | null
  token?: string
  tokenType?: "portal" | "bid"
  claimEmail?: string
  claimFullName?: string
  children: ReactNode
}

/**
 * The one chrome every token portal renders. Lives in the route layout so it
 * mounts once and survives navigation between portal pages — the nav does not
 * re-render, and each page owns only its own content.
 */
export function PortalShell({
  identity,
  root,
  nav,
  workspace = null,
  token,
  tokenType,
  claimEmail = "",
  claimFullName = "",
  children,
}: PortalShellProps) {
  return (
    <div
      className="flex min-h-screen flex-col bg-background"
      style={{ ["--portal-header-height" as string]: "4.125rem" }}
    >
      <PortalBrandHeader
        identity={identity}
        workspace={workspace}
        token={token}
        tokenType={tokenType}
        claimEmail={claimEmail}
        claimFullName={claimFullName}
      />

      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-0 px-4 sm:px-6">
        <PortalSideNav root={root} items={nav} />
        <main className="min-w-0 flex-1 py-6 pb-24 md:border-l md:border-border md:py-8 md:pb-12 md:pl-8">
          {children}
        </main>
      </div>

      <footer className="mt-auto hidden border-t border-border md:block">
        <div className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6">
          <p className="text-xs text-muted-foreground">
            {identity.orgName} runs on Arc
          </p>
        </div>
      </footer>

      <PortalBottomNav root={root} items={nav} />
    </div>
  )
}
