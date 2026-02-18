"use client"

import { useState, useTransition } from "react"
import { signOutAction } from "@/app/(auth)/auth/actions"
import {
  ChevronsUpDown,
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
import { SettingsDialog } from "@/components/settings/settings-dialog"
import { useHydrated } from "@/hooks/use-hydrated"

export function NavUser({
  user,
}: {
  user?: User | null
}) {
  const { isMobile, state } = useSidebar()
  const [signingOut, startSignOut] = useTransition()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<string>("profile")
  const hydrated = useHydrated()

  const initials =
    user?.full_name
      ?.split(" ")
      .map((n) => n[0])
      .join("") || "?"

  const openSettings = (targetTab: string) => {
    setSettingsTab(targetTab)
    setSettingsOpen(true)
  }

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
              <DropdownMenuItem
                className="rounded-none px-2.5 py-2.5"
                onSelect={(event) => {
                  event.preventDefault()
                  openSettings("profile")
                }}
              >
                <Settings />
                Settings
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
        <SettingsDialog
          user={user ?? null}
          open={settingsOpen}
          initialTab={settingsTab}
          onOpenChange={setSettingsOpen}
        />
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
