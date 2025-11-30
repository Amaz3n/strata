"use client"

import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { CommandSearch } from "@/components/layout/command-search"
import { NotificationBell } from "@/components/notifications/notification-bell"
import { cn } from "@/lib/utils"

interface AppHeaderProps {
  title?: string
  className?: string
}

export function AppHeader({ title, className }: AppHeaderProps) {
  return (
    <header
      className={cn(
        "flex h-16 shrink-0 items-center transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12",
        className,
      )}
    >
      {/* Left section - Sidebar and title */}
      <div className="flex items-center gap-2 px-4 flex-1">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 h-4" />

        {/* Page title */}
        {title && (
          <div className="flex flex-col gap-0.5 leading-none">
            <span className="font-medium">{title}</span>
          </div>
        )}
      </div>

      {/* Center section - Search */}
      <div className="flex-1 flex justify-center">
        <CommandSearch />
      </div>

      {/* Right section - Actions */}
      <div className="flex items-center gap-2 px-4 flex-1 justify-end">
        <NotificationBell />
      </div>
    </header>
  )
}
