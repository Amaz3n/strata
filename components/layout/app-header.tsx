"use client"

import * as React from "react"

import { CommandSearch } from "@/components/layout/command-search"
import { NotificationBell } from "@/components/notifications/notification-bell"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { cn } from "@/lib/utils"

export type AppBreadcrumbItem = {
  label: string
  href?: string
}

interface AppHeaderProps {
  title?: string
  breadcrumbs?: AppBreadcrumbItem[]
  className?: string
}

export function AppHeader({ title, breadcrumbs, className }: AppHeaderProps) {
  const breadcrumbItems = breadcrumbs?.length ? breadcrumbs : title ? [{ label: title }] : []

  return (
    <header
      className={cn(
        "flex h-16 shrink-0 items-center transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 border-b border-border",
        className,
      )}
    >
      {/* Left section - Sidebar trigger + breadcrumbs */}
      <div className="flex items-center gap-2 px-4 flex-1 min-w-0">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 h-4" />

        {breadcrumbItems.length > 0 && (
          <Breadcrumb className="flex min-w-0 items-center">
            <BreadcrumbList className="flex min-w-0 items-center">
              {breadcrumbItems.map((item, index) => {
                const isLast = index === breadcrumbItems.length - 1
                const content = isLast ? (
                  <BreadcrumbPage className="truncate">{item.label}</BreadcrumbPage>
                ) : item.href ? (
                  <BreadcrumbLink href={item.href} className="truncate">
                    {item.label}
                  </BreadcrumbLink>
                ) : (
                  <span className="truncate text-muted-foreground">{item.label}</span>
                )

                return (
                  <React.Fragment key={`${item.label}-${index}`}>
                    <BreadcrumbItem className="min-w-0">{content}</BreadcrumbItem>
                    {index < breadcrumbItems.length - 1 && <BreadcrumbSeparator />}
                  </React.Fragment>
                )
              })}
            </BreadcrumbList>
          </Breadcrumb>
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
