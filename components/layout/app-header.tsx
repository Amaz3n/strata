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
import { ProjectSwitcher } from "./project-switcher"
import { usePageTitle } from "./page-title-context"

export type AppBreadcrumbItem = {
  label: string
  href?: string
  isProject?: boolean
  projectId?: string
}

interface AppHeaderProps {
  title?: string
  breadcrumbs?: AppBreadcrumbItem[]
  className?: string
}

export function AppHeader({ title, breadcrumbs, className }: AppHeaderProps) {
  const { title: contextTitle } = usePageTitle()
  const effectiveTitle = title || contextTitle
  const breadcrumbItems = breadcrumbs?.length ? breadcrumbs : effectiveTitle ? [{ label: effectiveTitle }] : []

  // Get current page title for mobile display
  const currentPage = breadcrumbItems.length > 0 ? breadcrumbItems[breadcrumbItems.length - 1] : null

  return (
    <header
      className={cn(
        "shrink-0 transition-[width,height] ease-linear border-b border-border",
        className,
      )}
    >
      {/* Desktop Header - Single Row */}
      <div className="hidden lg:flex h-14 items-center">
        {/* Left section - Sidebar trigger + breadcrumbs */}
        <div className="flex items-center gap-2 px-4 flex-1 min-w-0">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />

          {breadcrumbItems.length > 0 && (
            <Breadcrumb className="flex min-w-0 items-center">
              <BreadcrumbList className="flex min-w-0 items-center">
                {breadcrumbItems.map((item, index) => {
                  const isLast = index === breadcrumbItems.length - 1
                  const content = item.isProject ? (
                    <ProjectSwitcher
                      currentProjectId={item.projectId}
                      currentProjectLabel={item.label}
                    />
                  ) : isLast ? (
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
        <div className="flex-shrink-0">
          <CommandSearch />
        </div>

        {/* Right section - Actions */}
        <div className="flex items-center gap-2 px-4 flex-1 justify-end">
          <NotificationBell />
        </div>
      </div>

      {/* Mobile Header - Single Row */}
      <div className="lg:hidden flex h-14 items-center px-4 gap-3">
        <SidebarTrigger className="-ml-1 shrink-0" />

        {/* Page title - takes remaining space */}
        <div className="flex-1 min-w-0">
          {currentPage && (
            <h1 className="text-base font-semibold truncate">
              {currentPage.label}
            </h1>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <CommandSearch />
          <NotificationBell />
        </div>
      </div>
    </header>
  )
}
