"use client"

import * as React from "react"
import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { ChevronsUpDown, FolderOpen, Loader2, Plus, Users } from "@/components/icons"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
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

        setOrgs(memberships)

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
      } finally {
        setIsLoading(false)
      }
    }

    loadOrgs()
  }, [])

  const activeOrg = orgs.find((o) => o.org_id === activeOrgId)

  const handleSelect = (targetOrgId: string) => {
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
          <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-6 items-center justify-center rounded-lg">
            <org.logo className="size-3" />
          </div>
          {state !== "collapsed" && (
            <Skeleton className="h-4 w-28" />
          )}
        </>
      )
    }

    if (!activeOrg) {
      return (
        <>
          <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-6 items-center justify-center rounded-lg">
            <org.logo className="size-3" />
          </div>
          {state !== "collapsed" && (
            <>
              <span className="truncate font-medium text-sm">No organization</span>
              <ChevronsUpDown className="ml-auto size-4" />
            </>
          )}
        </>
      )
    }

    return (
      <>
        <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-6 items-center justify-center rounded-lg">
          <org.logo className="size-3" />
        </div>
        {state !== "collapsed" && (
          <>
            <span className="truncate font-medium text-sm">{activeOrg.org_name}</span>
            {isPending ? <Loader2 className="ml-auto size-4 animate-spin" /> : <ChevronsUpDown className="ml-auto size-4" />}
          </>
        )}
      </>
    )
  }

  return (
    <SidebarMenu suppressHydrationWarning className="w-full">
      <SidebarMenuItem className="w-full">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              className="h-10 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              {renderCurrent()}
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              Organizations
            </DropdownMenuLabel>
            {loadError && (
              <div className="text-destructive px-2 py-3 text-xs whitespace-pre-wrap">
                {loadError}
              </div>
            )}
            {!loadError && orgs.length === 0 && (
              <div className="text-muted-foreground px-2 py-3 text-sm">No organizations found.</div>
            )}

            {orgs.map((item) => (
              <DropdownMenuItem
                key={item.org_id}
                className="gap-2 p-2"
                onSelect={() => handleSelect(item.org_id)}
              >
                <div className="flex size-6 items-center justify-center rounded-md border">
                  <org.logo className="size-3.5 shrink-0" />
                </div>
                <div className="flex flex-col">
                  <span>{item.org_name}</span>
                  <span className="text-muted-foreground text-xs">{item.role_key ?? "member"}</span>
                </div>
                {item.org_id === activeOrgId && <DropdownMenuShortcut>Current</DropdownMenuShortcut>}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              Organization
            </DropdownMenuLabel>
            <DropdownMenuItem className="gap-2 p-2" asChild>
              <Link href="/projects" className="flex items-center gap-2">
                <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                  <FolderOpen className="size-4" />
                </div>
                <div className="font-medium">All Projects</div>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2 p-2" asChild>
              <Link href="/directory" className="flex items-center gap-2">
                <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                  <Users className="size-4" />
                </div>
                <div className="font-medium">Directory</div>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2 p-2" asChild>
              <Link href="/admin/provision" className="flex items-center gap-2">
                <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                  <Plus className="size-4" />
                </div>
                <div className="text-muted-foreground font-medium">Create Organization</div>
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
