"use client"

import { useTransition } from "react"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { signOutAction } from "@/app/(auth)/auth/actions"
import {
  ChevronsUpDown,
  HardHat,
  LogOut,
  Mail,
  Settings,
} from "@/components/icons"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
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
import type { User } from "@/lib/types"
import { useHydrated } from "@/hooks/use-hydrated"

export function NavUser({
  user,
  canAccessPlatform,
}: {
  user?: User | null
  canAccessPlatform?: boolean
}) {
  const { isMobile, state } = useSidebar()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [signingOut, startSignOut] = useTransition()
  const hydrated = useHydrated()
  const currentUrl = `${pathname}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`
  const settingsHref = `/settings?tab=profile&returnTo=${encodeURIComponent(currentUrl)}`

  const initials =
    user?.full_name
      ?.split(" ")
      .map((n) => n[0])
      .join("") || "?"

  if (!hydrated) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="lg"
            className="group-data-[collapsible=icon]:justify-center"
          >
            <Avatar className="h-6 w-6 rounded-none">
              <AvatarImage src={user?.avatar_url} alt={user?.full_name ?? "User"} />
              <AvatarFallback className="rounded-none bg-sidebar-primary text-sidebar-primary-foreground text-xs">
                {initials}
              </AvatarFallback>
            </Avatar>
            {state !== "collapsed" && (
              <div className="flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{user?.full_name ?? "Signed In"}</span>
              </div>
            )}
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
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
              <Avatar className="h-6 w-6 rounded-none">
                <AvatarImage src={user?.avatar_url} alt={user?.full_name ?? "User"} />
                <AvatarFallback className="rounded-none bg-sidebar-primary text-sidebar-primary-foreground text-xs">
                  {initials}
                </AvatarFallback>
              </Avatar>
              {state !== "collapsed" && (
                <>
                  <div className="flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{user?.full_name ?? "Signed In"}</span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4" />
                </>
              )}
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-max min-w-[max(16rem,var(--radix-dropdown-menu-trigger-width))] max-w-[calc(100vw-1.5rem)] rounded-none border-border/80 bg-popover/95 p-2 shadow-xl backdrop-blur supports-[backdrop-filter]:bg-popover/85"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="px-2 pb-2 pt-1 text-left font-normal">
              <div className="flex items-center gap-3 text-sm">
                <Avatar className="h-8 w-8 rounded-none border border-sidebar-border/70">
                  <AvatarImage src={user?.avatar_url} alt={user?.full_name ?? "User"} />
                  <AvatarFallback className="rounded-none bg-sidebar-primary text-sidebar-primary-foreground">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{user?.full_name ?? "Signed In"}</span>
                  <span className="block truncate text-xs text-muted-foreground">{user?.email ?? ""}</span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuGroup>
              {canAccessPlatform && (
                <DropdownMenuItem className="rounded-none px-2.5 py-2.5 font-medium text-cyan-600 dark:text-cyan-400" asChild>
                  <Link href="/platform">
                    <HardHat className="size-4" />
                    Platform
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem className="rounded-none px-2.5 py-2.5" asChild>
                <Link href={settingsHref}>
                  <Settings />
                  Settings
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem className="rounded-none px-2.5 py-2.5" asChild>
                <a href="mailto:support@arcnaples.com">
                  <Mail />
                  Contact Support
                </a>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="rounded-none px-2.5 py-2.5 text-destructive"
              onSelect={(event) => {
                event.preventDefault()
                startSignOut(async () => {
                  await signOutAction()
                })
              }}
            >
              <LogOut />
              {signingOut ? "Signing out..." : "Log out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
