"use client"

import * as React from "react"
import { usePathname } from "next/navigation"

import Link from "next/link"

import { ChevronRight, MapPin } from "@/components/icons"
import { CommandSearch } from "@/components/layout/command-search-lazy"
import { PlatformSessionControl } from "@/components/layout/platform-session-control"
import { ScopeSwitcher, type ScopeDivision } from "@/components/layout/scope-switcher"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import type { AmbientCommunity } from "@/lib/services/desk-context"
import type { PlatformAccessState } from "@/lib/services/platform-access"
import type { PlatformSessionState } from "@/lib/services/platform-session"
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
  divisions?: ScopeDivision[]
  divisionId?: string
  communities?: AmbientCommunity[]
  communityId?: string
  showCommunityScope?: boolean
  platformAccess?: PlatformAccessState
  platformSessionState?: PlatformSessionState
}

const PATHNAME_FALLBACK_LABELS: Record<string, string> = {
  "": "Control Tower",
  directory: "Directory",
  companies: "Directory",
  contacts: "Directory",
  projects: "Projects",
  communities: "Communities",
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
  "design-studio": "Design Studio",
  purchasing: "Purchasing",
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

/** One separator for the whole header path, from the scope lens to the last crumb. */
function PathSeparator() {
  return (
    <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground/50" />
  )
}

export function AppHeader({
  divisions = [],
  divisionId,
  communities = [],
  communityId,
  showCommunityScope = false,
  platformAccess,
  platformSessionState,
}: AppHeaderProps) {
  const pathname = usePathname()
  const { title, breadcrumbs, projectContext } = usePageTitle()
  const fallbackLabel = labelFromPathname(pathname)
  const breadcrumbItems = breadcrumbs?.length
    ? breadcrumbs
    : title
      ? [{ label: title }]
      : [{ label: fallbackLabel }]

  // Get current page title for mobile display
  const currentPage = breadcrumbItems.length > 0 ? breadcrumbItems[breadcrumbItems.length - 1] : null

  // Eyebrow shows the project name when inside a project.
  // Prefer the layout-provided projectContext; fall back to breadcrumb heuristic.
  const projectEyebrow = projectContext
    ? { label: projectContext.contextLabel ?? projectContext.name, href: projectContext.contextHref ?? projectContext.href }
    : breadcrumbItems.length > 1 && breadcrumbItems[0]?.href?.startsWith("/projects/")
      ? breadcrumbItems[0]
      : null

  // Inside a single project or community the URL already fixes the scope, so the
  // lens gives way to a link back up to the record that owns the page.
  const isRecordScoped =
    /^\/projects\/[^/]+/.test(pathname) || /^\/communities\/[^/]+/.test(pathname)
  const showScope =
    !isRecordScoped && (divisions.length > 0 || (showCommunityScope && communities.length > 1))
  const recordContext =
    isRecordScoped && projectContext?.contextLabel && projectContext.contextHref
      ? { label: projectContext.contextLabel, href: projectContext.contextHref }
      : null

  if (pathname.startsWith("/settings")) return null

  const scopeSlot = showScope ? (
    <ScopeSwitcher
      divisions={divisions}
      divisionId={divisionId}
      communities={communities}
      communityId={communityId}
      showCommunities={showCommunityScope}
    />
  ) : recordContext ? (
    <Link
      href={recordContext.href}
      className="flex h-8 min-w-0 max-w-[22rem] items-center gap-2 border border-transparent px-2.5 text-sm text-muted-foreground transition-colors hover:border-border/50 hover:bg-accent/60 hover:text-foreground"
    >
      <MapPin className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{recordContext.label}</span>
    </Link>
  ) : null

  const platformSessionControl =
    platformAccess && platformSessionState ? (
      <PlatformSessionControl access={platformAccess} state={platformSessionState} />
    ) : null

  return (
    <header className="shrink-0 border-b border-border">
      {/* Desktop — one row: scope, path, then search pinned right */}
      <div className="hidden h-14 items-center gap-2 px-3 lg:flex">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {scopeSlot}
          {scopeSlot ? <PathSeparator /> : null}

          <Breadcrumb className="flex min-w-0 items-center">
            <BreadcrumbList className="flex min-w-0 flex-nowrap items-center gap-2 text-sm sm:gap-2">
              {breadcrumbItems.map((item, index) => {
                const isLast = index === breadcrumbItems.length - 1
                const content = isLast ? (
                  <BreadcrumbPage className="font-medium">
                    <SlidingLabel label={item.label} />
                  </BreadcrumbPage>
                ) : item.onClick ? (
                  <BreadcrumbLink
                    href={item.href ?? "#"}
                    className="text-muted-foreground"
                    onClick={(event) => {
                      event.preventDefault()
                      item.onClick?.()
                    }}
                  >
                    <SlidingLabel label={item.label} />
                  </BreadcrumbLink>
                ) : item.href ? (
                  <BreadcrumbLink href={item.href} className="text-muted-foreground">
                    <SlidingLabel label={item.label} />
                  </BreadcrumbLink>
                ) : (
                  <SlidingLabel label={item.label} className="text-muted-foreground" />
                )

                return (
                  <React.Fragment key={`${item.label}-${index}`}>
                    <BreadcrumbItem className="min-w-0">{content}</BreadcrumbItem>
                    {!isLast && (
                      <BreadcrumbSeparator className="flex items-center">
                        <PathSeparator />
                      </BreadcrumbSeparator>
                    )}
                  </React.Fragment>
                )
              })}
            </BreadcrumbList>
          </Breadcrumb>
        </div>

        {platformSessionControl}
        <CommandSearch />
      </div>

      {/* Mobile — title block, search pinned right */}
      <div className="flex h-16 items-center gap-3 px-4 lg:hidden">
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          {projectEyebrow?.href && (
            <Link
              href={projectEyebrow.href}
              className="block truncate text-xs leading-none font-semibold tracking-wider text-primary/85 uppercase transition-colors hover:text-primary"
            >
              {projectEyebrow.label}
            </Link>
          )}
          {!projectEyebrow && showScope && (
            <div className="-ml-2 flex items-center">
              <ScopeSwitcher
                divisions={divisions}
                divisionId={divisionId}
                communities={communities}
                communityId={communityId}
                showCommunities={showCommunityScope}
                className="h-7 border-transparent px-2 text-xs"
              />
            </div>
          )}
          {currentPage && (
            <h1 className="truncate text-xl leading-tight font-semibold">{currentPage.label}</h1>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {platformSessionControl}
          <CommandSearch />
        </div>
      </div>
    </header>
  )
}
