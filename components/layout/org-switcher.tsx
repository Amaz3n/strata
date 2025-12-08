"use client"

import * as React from "react"
import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { ChevronsUpDown, Loader2, Plus } from "lucide-react"
import Link from "next/link"

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
import { listMembershipsAction, switchOrgAction, type OrgMembershipSummary } from "@/app/actions/orgs"
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
  const [isLoading, startTransition] = useTransition()

  useEffect(() => {
    async function loadOrgs() {
      const data = await listMembershipsAction()
      setOrgs(data)

      const cookieOrg =
        typeof document !== "undefined"
          ? document.cookie
              .split(";")
              .map((c) => c.trim())
              .find((c) => c.startsWith("org_id="))
              ?.split("=")?.[1]
          : null

      const resolvedOrg = cookieOrg || data[0]?.org_id || null
      setActiveOrgId(resolvedOrg)
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
    if (isLoading || !activeOrg) {
      return (
        <>
          <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-6 items-center justify-center rounded-lg">
            <org.logo className="size-3" />
          </div>
          {state !== "collapsed" && (
            <div className="grid flex-1 text-left text-sm leading-tight">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-16" />
            </div>
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
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{activeOrg.org_name}</span>
              <span className="truncate text-xs">{activeOrg.billing_model ?? org.plan}</span>
            </div>
            {isLoading ? <Loader2 className="ml-auto animate-spin" /> : <ChevronsUpDown className="ml-auto" />}
          </>
        )}
      </>
    )
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground group-data-[collapsible=icon]:justify-center"
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
            {orgs.length === 0 && (
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
