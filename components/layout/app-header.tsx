"use client"

import * as React from "react"
import { usePathname } from "next/navigation"

import Link from "next/link"

import { CommandSearch } from "@/components/layout/command-search"
import { GlobalTasksSheet } from "@/components/tasks/global-tasks-sheet"
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
import { usePageTitle } from "./page-title-context"

export type AppBreadcrumbItem = {
  label: string
  href?: string
}

interface AppHeaderProps {
  title?: string
  breadcrumbs?: AppBreadcrumbItem[]
  className?: string
  platformSessionControl?: React.ReactNode
}

const PATHNAME_FALLBACK_LABELS: Record<string, string> = {
  "": "Control Tower",
  directory: "Directory",
  companies: "Directory",
  contacts: "Directory",
  projects: "Projects",
  pipeline: "Pipeline",
  prospects: "Prospects",
  crm: "CRM",
  estimates: "Estimates",
  schedule: "Schedule",
  tasks: "Tasks",
  documents: "Documents",
  drawings: "Drawings",
  rfis: "RFIs",
  submittals: "Submittals",
  selections: "Selections",
  decisions: "Decisions",
  "change-orders": "Change Orders",
  invoices: "Invoices",
  payments: "Payments",
  "financial-control": "Financial Control",
  signatures: "Signatures",
  emails: "Emails",
  warranty: "Warranty",
  closeout: "Closeout",
  team: "Team",
  settings: "Settings",
  admin: "Admin",
  platform: "Platform",
  sharing: "Sharing",
}

function labelFromPathname(pathname: string): string {
  const segment = pathname.split("/").filter(Boolean)[0] ?? ""
  return PATHNAME_FALLBACK_LABELS[segment] ?? "Home"
}

export function AppHeader({ title, breadcrumbs, className, platformSessionControl }: AppHeaderProps) {
  const pathname = usePathname()
  const { title: contextTitle, breadcrumbs: contextBreadcrumbs, projectContext } = usePageTitle()
  const effectiveTitle = title || contextTitle
  const effectiveBreadcrumbs = breadcrumbs || contextBreadcrumbs
  const fallbackLabel = labelFromPathname(pathname)
  const breadcrumbItems = effectiveBreadcrumbs?.length
    ? effectiveBreadcrumbs
    : effectiveTitle
      ? [{ label: effectiveTitle }]
      : [{ label: fallbackLabel }]

  // Get current page title for mobile display
  const currentPage = breadcrumbItems.length > 0 ? breadcrumbItems[breadcrumbItems.length - 1] : null

  // Eyebrow shows the project name when inside a project.
  // Prefer the layout-provided projectContext; fall back to breadcrumb heuristic.
  const projectEyebrow = projectContext
    ? { label: projectContext.name, href: projectContext.href }
    : breadcrumbItems.length > 1 && breadcrumbItems[0]?.href?.startsWith("/projects/")
      ? breadcrumbItems[0]
      : null

  if (pathname.startsWith("/settings")) return null

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

          {/* Always show breadcrumbs for debugging */}
          <Breadcrumb className="flex min-w-0 items-center">
            <BreadcrumbList className="flex min-w-0 items-center">
              {breadcrumbItems.length > 0 ? (
                breadcrumbItems.map((item, index) => {
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
                })
              ) : (
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbPage className="truncate">No breadcrumbs</BreadcrumbPage>
                </BreadcrumbItem>
              )}
            </BreadcrumbList>
          </Breadcrumb>
        </div>

        {/* Center section - Search */}
        <div className="flex-shrink-0">
          <CommandSearch />
        </div>

        {/* Right section - Actions */}
        <div className="flex items-center gap-2 px-4 flex-1 justify-end">
          {platformSessionControl}
          <GlobalTasksSheet />
        </div>
      </div>

      {/* Mobile Header - Single Row */}
      <div className="lg:hidden flex h-16 items-center px-4 gap-3">
        {/* Sidebar trigger only on md+ (tablets); phones use the bottom bar */}
        <SidebarTrigger className="-ml-1 shrink-0 hidden md:inline-flex" />

        {/* Title block - eyebrow (project name) + page title */}
        <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5">
          {projectEyebrow?.href && (
            <Link
              href={projectEyebrow.href}
              className="block truncate text-xs font-semibold uppercase tracking-wider leading-none text-primary/85 transition-colors hover:text-primary"
            >
              {projectEyebrow.label}
            </Link>
          )}
          {currentPage && (
            <h1 className="text-xl font-semibold truncate leading-tight">
              {currentPage.label}
            </h1>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {platformSessionControl}
          <CommandSearch />
          <GlobalTasksSheet />
        </div>
      </div>
    </header>
  )
}
