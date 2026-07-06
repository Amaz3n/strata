"use client"

import * as React from "react"
import { usePathname } from "next/navigation"

import Link from "next/link"

import { CommandSearch } from "@/components/layout/command-search-lazy"
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
  onClick?: () => void
}

/**
 * Renders a breadcrumb label that compacts long text (e.g. long project names)
 * with a fade-out edge instead of wrapping to a second line. On hover the text
 * slides horizontally within its fixed box to reveal the full name, keeping the
 * header on a single line.
 */
function SlidingLabel({ label, className }: { label: string; className?: string }) {
  const outerRef = React.useRef<HTMLSpanElement>(null)
  const innerRef = React.useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = React.useState(0)

  React.useEffect(() => {
    const outer = outerRef.current
    const inner = innerRef.current
    if (!outer || !inner) return

    const measure = () => {
      setOverflow(Math.max(0, inner.scrollWidth - outer.clientWidth))
    }
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(outer)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [label])

  const isTruncated = overflow > 0
  // Reveal the very end (+8px) and pace the slide at a roughly constant speed.
  const slideDistance = isTruncated ? overflow + 8 : 0
  const duration = Math.min(4, Math.max(0.5, slideDistance / 70))

  return (
    <span
      ref={outerRef}
      title={isTruncated ? label : undefined}
      className={cn(
        "group/slide block max-w-[220px] overflow-hidden whitespace-nowrap",
        className,
      )}
      style={
        isTruncated
          ? {
              maskImage:
                "linear-gradient(to right, black calc(100% - 14px), transparent)",
              WebkitMaskImage:
                "linear-gradient(to right, black calc(100% - 14px), transparent)",
            }
          : undefined
      }
    >
      <span
        ref={innerRef}
        className="inline-block transition-transform ease-linear group-hover/slide:[transform:translateX(var(--slide-x))]"
        style={{
          ["--slide-x" as string]: `-${slideDistance}px`,
          transitionDuration: `${duration}s`,
        }}
      >
        {label}
      </span>
    </span>
  )
}

interface AppHeaderProps {
  title?: string
  breadcrumbs?: AppBreadcrumbItem[]
  className?: string
  platformSessionControlDesktop?: React.ReactNode
  platformSessionControlMobile?: React.ReactNode
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
  signatures: "Signatures",
  emails: "Emails",
  warranty: "Warranty",
  closeout: "Closeout",
  team: "Team",
  settings: "Settings",
  admin: "Admin",
  platform: "Platform",
  sharing: "Sharing",
  "whats-new": "What's New",
}

function labelFromPathname(pathname: string): string {
  const segment = pathname.split("/").filter(Boolean)[0] ?? ""
  return PATHNAME_FALLBACK_LABELS[segment] ?? "Home"
}

export function AppHeader({ title, breadcrumbs, className, platformSessionControlDesktop, platformSessionControlMobile }: AppHeaderProps) {
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

          <Breadcrumb className="flex min-w-0 items-center">
            <BreadcrumbList className="flex min-w-0 flex-nowrap items-center">
              {breadcrumbItems.length > 0 ? (
                breadcrumbItems.map((item, index) => {
                  const isLast = index === breadcrumbItems.length - 1
                  const content = isLast ? (
                    <BreadcrumbPage>
                      <SlidingLabel label={item.label} />
                    </BreadcrumbPage>
                  ) : item.onClick ? (
                    <BreadcrumbLink
                      href={item.href ?? "#"}
                      onClick={(event) => {
                        event.preventDefault()
                        item.onClick?.()
                      }}
                    >
                      <SlidingLabel label={item.label} />
                    </BreadcrumbLink>
                  ) : item.href ? (
                    <BreadcrumbLink href={item.href}>
                      <SlidingLabel label={item.label} />
                    </BreadcrumbLink>
                  ) : (
                    <SlidingLabel label={item.label} className="text-muted-foreground" />
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
          {platformSessionControlDesktop}
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
          {platformSessionControlMobile}
          <CommandSearch />
          <GlobalTasksSheet />
        </div>
      </div>
    </header>
  )
}
