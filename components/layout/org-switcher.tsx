"use client"

import * as React from "react"
import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { ChevronsUpDown, Loader2, Plus } from "@/components/icons"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { switchOrgAction, type OrgMembershipSummary } from "@/app/actions/orgs"
import { Skeleton } from "@/components/ui/skeleton"
import { useHydrated } from "@/hooks/use-hydrated"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"

export function OrgSwitcher({
  org,
}: {
  org: {
    name: string
    logo: React.ElementType
    plan: string
  }
}) {
  const { isMobile, state } = useSidebar()
  const router = useRouter()
  const [orgs, setOrgs] = useState<OrgMembershipSummary[]>([])
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [canCreateOrganization, setCanCreateOrganization] = useState(false)
  const hydrated = useHydrated()

  useEffect(() => {
    async function loadOrgs() {
      try {
        const response = await fetch("/api/orgs", { next: { revalidate: 300 } }) // Cache for 5 minutes
        if (!response.ok) {
          const text = await response.text()
          throw new Error(`Org fetch failed (${response.status}): ${text}`)
        }
        const payload = await response.json()
        const memberships = (payload?.orgs ?? []) as OrgMembershipSummary[]
        const canCreate =
          typeof payload?.canCreateOrganization === "boolean"
            ? payload.canCreateOrganization
            : false

        setOrgs(memberships)
        setCanCreateOrganization(canCreate)

        const cookieOrg =
          typeof document !== "undefined"
            ? document.cookie
                .split(";")
                .map((c) => c.trim())
                .find((c) => c.startsWith("org_id="))
                ?.split("=")?.[1]
            : null

        const resolvedOrg = cookieOrg || memberships[0]?.org_id || null
        setActiveOrgId(resolvedOrg)
        setLoadError(null)
      } catch (error) {
        console.error("Failed to load organizations", error)
        setLoadError(error instanceof Error ? error.message : "Unknown error")
        setOrgs([])
        setActiveOrgId(null)
        setCanCreateOrganization(false)
      } finally {
        setIsLoading(false)
      }
    }

    loadOrgs()
  }, [])

  const activeOrg = orgs.find((o) => o.org_id === activeOrgId)

  const renderOrgMark = (logoUrl: string | null | undefined, label: string, large = false) => (
    <Avatar
      className={cn(
        "rounded-none border border-sidebar-border/70 bg-sidebar-primary/15",
        large ? "size-8" : "size-6",
      )}
    >
      {logoUrl ? <AvatarImage src={logoUrl} alt={`${label} logo`} className="object-cover" /> : null}
      <AvatarFallback className="bg-sidebar-primary text-sidebar-primary-foreground rounded-none">
        <org.logo className="size-3" />
      </AvatarFallback>
    </Avatar>
  )

  const handleSelect = (targetOrgId: string) => {
    if (!targetOrgId || targetOrgId === activeOrgId || isPending) {
      return
    }

    startTransition(async () => {
      await switchOrgAction(targetOrgId)
      setActiveOrgId(targetOrgId)
      router.refresh()
    })
  }

  const renderCurrent = () => {
    if (isLoading) {
      return (
        <>
          {renderOrgMark(null, org.name)}
          {state !== "collapsed" && (
            <Skeleton className="h-4 w-28" />
          )}
        </>
      )
    }

    if (!activeOrg) {
      return (
        <>
          {renderOrgMark(null, "No organization")}
          {state !== "collapsed" && (
            <>
              <span className="min-w-0 flex-1 truncate whitespace-nowrap font-medium text-sm">No organization</span>
              <ChevronsUpDown className="ml-auto size-4" />
            </>
          )}
        </>
      )
    }

    return (
      <>
        {renderOrgMark(activeOrg.logo_url, activeOrg.org_name)}
        {state !== "collapsed" && (
          <>
            <span className="min-w-0 flex-1 truncate whitespace-nowrap font-medium text-sm">{activeOrg.org_name}</span>
            {isPending ? <Loader2 className="ml-auto size-4 animate-spin" /> : <ChevronsUpDown className="ml-auto size-4" />}
          </>
        )}
      </>
    )
  }

  if (!hydrated) {
    return (
      <SidebarMenu className="w-full">
        <SidebarMenuItem className="w-full">
          <SidebarMenuButton className="h-10 group-data-[collapsible=icon]:justify-center">
            {renderCurrent()}
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    )
  }

  return (
    <SidebarMenu className="w-full">
      <SidebarMenuItem className="w-full">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              className="h-10 min-w-0 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground group-data-[collapsible=icon]:justify-center"
            >
              {renderCurrent()}
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-max min-w-[max(19rem,var(--radix-dropdown-menu-trigger-width))] max-w-[calc(100vw-1.5rem)] rounded-none border-border/80 bg-popover/95 p-2 shadow-xl backdrop-blur supports-[backdrop-filter]:bg-popover/85"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="px-2 pb-2 text-[11px] tracking-wide text-muted-foreground uppercase">
              Switch organization
            </DropdownMenuLabel>
            {loadError && (
              <div className="px-2 py-3 text-xs whitespace-pre-wrap text-destructive">
                {loadError}
              </div>
            )}
            {!loadError && orgs.length === 0 && (
              <div className="text-muted-foreground px-2 py-3 text-sm">No organizations found.</div>
            )}

            {orgs.map((item) => (
              <DropdownMenuItem
                key={item.org_id}
                className={cn(
                  "group min-w-0 gap-3 rounded-none px-2.5 py-2.5",
                  item.org_id === activeOrgId && "border border-primary/30 bg-primary/5",
                )}
                onSelect={() => handleSelect(item.org_id)}
              >
                {renderOrgMark(item.logo_url, item.org_name, true)}
                <div className="flex-1">
                  <div className="whitespace-nowrap text-sm font-medium">
                    {item.org_name}
                  </div>
                  <div className="text-muted-foreground whitespace-nowrap text-xs capitalize">
                    {item.role_key ?? "member"}
                  </div>
                </div>
              </DropdownMenuItem>
            ))}
            {canCreateOrganization && (
              <>
                <DropdownMenuSeparator className="my-2" />
                <DropdownMenuItem className="gap-3 rounded-none px-2.5 py-2.5" asChild>
                  <Link href="/admin/provision" className="flex items-center gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-none border border-border/70 bg-background/70">
                      <Plus className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium">Create Organization</div>
                      <div className="text-muted-foreground text-xs">Owner access only</div>
                    </div>
                  </Link>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
