import Image from "next/image"

import { ExternalWorkspaceSwitcher } from "@/components/portal/external-workspace-switcher"
import { PortalClaimAccount } from "./portal-claim-account"
import type { ExternalPortalWorkspaceContext } from "@/lib/types"

export interface PortalIdentity {
  orgName: string
  logoUrl?: string | null
  /** Context line under the builder name — usually the project. */
  contextLabel: string
  contextDetail?: string | null
}

interface PortalBrandHeaderProps {
  identity: PortalIdentity
  workspace?: ExternalPortalWorkspaceContext | null
  token?: string
  tokenType?: "portal" | "bid"
  claimEmail?: string
  claimFullName?: string
}

/**
 * The builder's masthead, not Arc's. Subs and buyers open this a handful of
 * times and should recognise who sent it, so the org logo and name lead and
 * Arc is credited quietly in the footer instead.
 */
export function PortalBrandHeader({
  identity,
  workspace = null,
  token,
  tokenType,
  claimEmail = "",
  claimFullName = "",
}: PortalBrandHeaderProps) {
  const initials = identity.orgName.slice(0, 2).toUpperCase()

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
        <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden border border-border bg-card">
          {identity.logoUrl ? (
            <Image
              src={identity.logoUrl}
              alt={`${identity.orgName} logo`}
              width={40}
              height={40}
              className="size-full object-contain p-1"
              unoptimized
            />
          ) : (
            <span className="text-xs font-semibold text-muted-foreground">{initials}</span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-tight text-foreground">
            {identity.orgName}
          </p>
          <p className="truncate text-xs leading-tight text-muted-foreground">
            {identity.contextLabel}
            {identity.contextDetail ? (
              <span className="hidden sm:inline"> · {identity.contextDetail}</span>
            ) : null}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {workspace ? (
            <ExternalWorkspaceSwitcher workspace={workspace} />
          ) : token && tokenType ? (
            <PortalClaimAccount
              token={token}
              tokenType={tokenType}
              email={claimEmail}
              suggestedFullName={claimFullName}
            />
          ) : null}
        </div>
      </div>
    </header>
  )
}
