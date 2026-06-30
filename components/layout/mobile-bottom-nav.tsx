"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useSearchParams } from "next/navigation"
import { AnimatePresence, motion } from "framer-motion"
import { OptimisticLink, useOptimisticPathname } from "@/lib/navigation/optimistic-pathname"
import { signOutAction } from "@/app/(auth)/auth/actions"
import {
  Briefcase,
  Building2,
  CircleHelp,
  Contact,
  FolderOpen,
  Hammer,
  HardHat,
  Home,
  LayoutDashboard,
  LogOut,
  MoreHorizontal,
  Plus,
  Settings,
  Sparkles,
  Wallet,
  X,
} from "@/components/icons"
import type { LucideIcon } from "@/components/icons"
import { useMobileAction } from "@/components/layout/mobile-action-context"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { Project, User } from "@/lib/types"
import { cn } from "@/lib/utils"
import { getProjectFinancialFeatureConfig } from "@/lib/financials/billing-model"
import { useSidebarProjects } from "./use-sidebar-projects"

interface MobileBottomNavProps {
  user?: User | null
  pipelineBadgeCount?: number
  canAccessPlatform?: boolean
  permissions?: string[]
  whatsNewUnreadCount?: number
}

type NavSubItem = {
  title: string
  url: string
  isActive?: boolean
  requiredAny?: string[]
}

type NavItem = {
  title: string
  url: string
  icon: LucideIcon
  isActive?: boolean
  badge?: number
  requiredAny?: string[]
  subItems?: NavSubItem[]
}

type MenuSection = {
  label: string
  items: NavItem[]
}

function getProjectIdFromPath(pathname: string): string | null {
  if (pathname === "/projects" || pathname.startsWith("/projects?")) return null
  const match = pathname.match(/^\/projects\/([^/]+)/)
  return match?.[1] ?? null
}

function getProjectSection(pathname: string): string {
  if (pathname.includes("/drawings")) return "drawings"
  if (pathname.includes("/rfis")) return "rfis"
  if (pathname.includes("/submittals")) return "submittals"
  if (pathname.includes("/decisions")) return "decisions"
  if (pathname.includes("/signatures")) return "signatures"
  if (pathname.includes("/documents")) return "documents"
  if (pathname.includes("/bids")) return "bids"
  if (pathname.includes("/change-orders")) return "change-orders"
  if (pathname.includes("/invoices")) return "invoices"
  if (pathname.includes("/financials/receivables")) return "receivables"
  if (pathname.includes("/financials/trust-center")) return "trust-center"
  if (pathname.includes("/budget")) return "budget"
  if (pathname.includes("/commitments")) return "commitments"
  if (pathname.includes("/payables")) return "payables"
  if (pathname.includes("/cost-inbox")) return "cost-inbox"
  if (pathname.includes("/time")) return "time"
  if (pathname.includes("/expenses")) return "expenses"
  if (pathname.includes("/reports")) return "reports"
  if (pathname.includes("/schedule")) return "schedule"
  if (pathname.includes("/tasks")) return "tasks"
  if (pathname.includes("/daily-logs")) return "daily-logs"
  if (pathname.includes("/punch")) return "punch"
  if (pathname.includes("/closeout")) return "closeout"
  if (pathname.includes("/warranty")) return "warranty"
  if (pathname.includes("/financials")) return "financials"
  return "overview"
}

function canAccess(requiredAny: string[] | undefined, permissions: Set<string>) {
  if (!requiredAny || requiredAny.length === 0) return true
  if (permissions.has("*") || permissions.has("org.admin")) return true
  return requiredAny.some((permission) => permissions.has(permission))
}

const FINANCIAL_SECTIONS = new Set([
  "financials",
  "budget",
  "commitments",
  "payables",
  "receivables",
  "invoices",
  "reports",
  "time",
  "expenses",
  "change-orders",
  "cost-inbox",
  "trust-center",
])
const BUILD_SECTIONS = new Set(["schedule", "daily-logs", "punch", "rfis", "submittals", "decisions"])
const PLAN_SECTIONS = new Set(["documents", "drawings", "bids", "signatures"])

function getFinancialLandingUrl(projectId: string, project?: Project) {
  const base = `/projects/${projectId}`
  if (!project) return `${base}/financials`
  const config = getProjectFinancialFeatureConfig(project, project.billing_contract)
  if (config.landingPage === "receivables") return `${base}/financials/receivables`
  if (config.landingPage === "budget") return `${base}/financials/budget`
  return `${base}/financials`
}

function buildFinancialSubItems(projectId: string, section: string, project?: Project): NavSubItem[] {
  const base = `/projects/${projectId}`
  const config = project ? getProjectFinancialFeatureConfig(project, project.billing_contract) : null

  return [
    config?.showInbox === false
      ? null
      : { title: "Inbox", url: `${base}/financials`, isActive: section === "financials" || section === "cost-inbox", requiredAny: ["budget.read", "invoice.read", "bill.read", "payment.read", "draw.read", "commitment.read"] },
    { title: "Budget", url: `${base}/financials/budget`, isActive: section === "budget" || section === "commitments", requiredAny: ["budget.read", "commitment.read"] },
    { title: "Receivables", url: `${base}/financials/receivables`, isActive: section === "receivables" || section === "invoices", requiredAny: ["invoice.read", "payment.read", "draw.read"] },
    { title: "Payables", url: `${base}/financials/payables`, isActive: section === "payables", requiredAny: ["bill.read", "commitment.read"] },
    { title: "Trust Center", url: `${base}/financials/trust-center`, isActive: section === "trust-center", requiredAny: ["invoice.read", "bill.read", "budget.read"] },
    config?.showTime === false
      ? null
      : { title: "Time", url: `${base}/time`, isActive: section === "time", requiredAny: ["invoice.read", "invoice.write"] },
    { title: "Expenses", url: `${base}/expenses`, isActive: section === "expenses", requiredAny: ["invoice.read", "invoice.write", "bill.read"] },
    { title: "Change Orders", url: `${base}/change-orders`, isActive: section === "change-orders", requiredAny: ["change_order.read"] },
  ].filter(Boolean) as NavSubItem[]
}

export function MobileBottomNav({
  user,
  pipelineBadgeCount,
  canAccessPlatform,
  permissions = [],
  whatsNewUnreadCount = 0,
}: MobileBottomNavProps) {
  const pathname = useOptimisticPathname()
  const searchParams = useSearchParams()
  const { action } = useMobileAction()
  const permissionSet = useMemo(() => new Set(permissions), [permissions])
  const [menuOpen, setMenuOpen] = useState(false)
  const [immersive, setImmersive] = useState(false)
  const [effectiveUnreadCount, setEffectiveUnreadCount] = useState(whatsNewUnreadCount)
  const [signingOut, startSignOut] = useTransition()
  const { projects } = useSidebarProjects()

  const projectId = getProjectIdFromPath(pathname)
  const isProject = Boolean(projectId)
  const section = isProject ? getProjectSection(pathname) : ""
  const currentProject = useMemo(
    () => projects.find((project) => project.id === projectId),
    [projects, projectId],
  )

  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  // Hide while an immersive overlay (file/image viewer) is open
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ active: boolean }>).detail
      setImmersive(Boolean(detail?.active))
    }
    window.addEventListener("arc-immersive-view", handler)
    return () => window.removeEventListener("arc-immersive-view", handler)
  }, [])

  useEffect(() => {
    if (immersive) setMenuOpen(false)
  }, [immersive])

  useEffect(() => {
    if (!menuOpen) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false)
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [menuOpen])

  const currentUrl = `${pathname}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`
  const settingsHref = `/settings?tab=profile&returnTo=${encodeURIComponent(currentUrl)}`

  useEffect(() => {
    setEffectiveUnreadCount(whatsNewUnreadCount)
  }, [whatsNewUnreadCount])

  useEffect(() => {
    const handleUnreadChange = (event: Event) => {
      const detail = (event as CustomEvent<{ unreadCount?: number }>).detail
      if (typeof detail?.unreadCount === "number") {
        setEffectiveUnreadCount(detail.unreadCount)
      }
    }
    window.addEventListener("arc-release-notes-unread-change", handleUnreadChange)
    return () => window.removeEventListener("arc-release-notes-unread-change", handleUnreadChange)
  }, [])

  const { primary, menuSections } = useMemo<{ primary: NavItem[]; menuSections: MenuSection[] }>(() => {
    if (isProject && projectId) {
      const base = `/projects/${projectId}`
      const buildSubs: NavSubItem[] = [
        { title: "Schedule", url: `${base}/schedule`, isActive: section === "schedule", requiredAny: ["schedule.read"] },
        { title: "Daily Logs", url: `${base}/daily-logs`, isActive: section === "daily-logs", requiredAny: ["daily_log.read"] },
        { title: "Punch", url: `${base}/punch`, isActive: section === "punch", requiredAny: ["punch.read", "punch.write"] },
        { title: "RFIs", url: `${base}/rfis`, isActive: section === "rfis", requiredAny: ["rfi.read"] },
        { title: "Submittals", url: `${base}/submittals`, isActive: section === "submittals", requiredAny: ["submittal.read"] },
        { title: "Decisions", url: `${base}/decisions`, isActive: section === "decisions", requiredAny: ["decision.read", "decision.write"] },
      ]
      const financialSubs = buildFinancialSubItems(projectId, section, currentProject)
      const planSubs: NavSubItem[] = [
        { title: "Documents", url: `${base}/documents`, isActive: section === "documents", requiredAny: ["docs.read"] },
        { title: "Drawings", url: `${base}/drawings`, isActive: section === "drawings", requiredAny: ["drawing.read", "docs.read"] },
        { title: "Bids", url: `${base}/bids`, isActive: section === "bids", requiredAny: ["bid.read", "bid.write"] },
        { title: "Signatures", url: `${base}/signatures`, isActive: section === "signatures", requiredAny: ["signature.read", "signature.send"] },
      ]
      const projectPrimary: NavItem[] = [
        {
          title: "Overview",
          url: base,
          icon: LayoutDashboard,
          isActive: section === "overview",
          requiredAny: ["org.member", "project.read"],
        },
        {
          title: "Plan",
          url: `${base}/documents`,
          icon: Briefcase,
          isActive: PLAN_SECTIONS.has(section),
          subItems: planSubs,
        },
        {
          title: "Build",
          url: `${base}/schedule`,
          icon: Hammer,
          isActive: BUILD_SECTIONS.has(section),
          subItems: buildSubs,
        },
        {
          title: "Financials",
          url: getFinancialLandingUrl(projectId, currentProject),
          icon: Wallet,
          isActive: FINANCIAL_SECTIONS.has(section),
          subItems: financialSubs,
        },
      ]

      const projectMenu: MenuSection[] = [
        {
          label: "Workspace",
          items: [
            { title: "Home", url: "/", icon: Home },
            { title: "Projects", url: "/projects", icon: FolderOpen, requiredAny: ["org.member", "project.read"] },
            {
              title: "Pipeline",
              url: "/pipeline",
              icon: Contact,
              badge: pipelineBadgeCount && pipelineBadgeCount > 0 ? pipelineBadgeCount : undefined,
              requiredAny: ["pipeline.read", "pipeline.write"],
            },
            { title: "Directory", url: "/directory", icon: Building2, requiredAny: ["directory.read", "directory.write"] },
          ],
        },
      ]

      return { primary: projectPrimary, menuSections: projectMenu }
    }

    const workspacePrimary: NavItem[] = [
      { title: "Home", url: "/", icon: Home, isActive: pathname === "/" },
      {
        title: "Projects",
        url: "/projects",
        icon: FolderOpen,
        isActive: pathname === "/projects" || pathname.startsWith("/projects"),
        requiredAny: ["org.member", "project.read"],
      },
      {
        title: "Pipeline",
        url: "/pipeline",
        icon: Contact,
        isActive: pathname.startsWith("/pipeline"),
        badge: pipelineBadgeCount && pipelineBadgeCount > 0 ? pipelineBadgeCount : undefined,
        requiredAny: ["pipeline.read", "pipeline.write"],
      },
    ]
    const workspaceMenu: MenuSection[] = [
      {
        label: "More",
        items: [
          {
            title: "Directory",
            url: "/directory",
            icon: Building2,
            isActive: pathname.startsWith("/directory"),
            requiredAny: ["directory.read", "directory.write"],
          },
        ],
      },
    ]
    return { primary: workspacePrimary, menuSections: workspaceMenu }
  }, [pathname, projectId, isProject, section, currentProject, pipelineBadgeCount])

  const visiblePrimary = useMemo(
    () =>
      primary
        .filter((item) => canAccess(item.requiredAny, permissionSet))
        .map((item) => ({
          ...item,
          subItems: item.subItems?.filter((sub) => canAccess(sub.requiredAny, permissionSet)),
        }))
        .filter((item) => !item.subItems || item.subItems.length > 0),
    [primary, permissionSet],
  )

  const visibleMenuSections = useMemo(
    () =>
      menuSections
        .map((section) => ({
          ...section,
          items: section.items
            .filter((item) => canAccess(item.requiredAny, permissionSet))
            .map((item) => ({
              ...item,
              subItems: item.subItems?.filter((sub) => canAccess(sub.requiredAny, permissionSet)),
            }))
            .filter((item) => !item.subItems || item.subItems.length > 0),
        }))
        .filter((section) => section.items.length > 0),
    [menuSections, permissionSet],
  )

  const initials =
    user?.full_name
      ?.split(" ")
      .map((n) => n[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"

  const menuHasActive = visibleMenuSections.some((section) =>
    section.items.some((item) => item.isActive || item.subItems?.some((sub) => sub.isActive)),
  )

  if (immersive) return null

  return (
    <>
      <AnimatePresence>
        {menuOpen && (
          <motion.button
            type="button"
            aria-label="Close menu"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={() => setMenuOpen(false)}
            className="md:hidden fixed inset-0 z-40 bg-foreground/30 backdrop-blur-[2px]"
          />
        )}
      </AnimatePresence>

      <div
        className="md:hidden fixed inset-x-0 bottom-0 z-50 pointer-events-none flex flex-col items-stretch"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}
      >
        <div className="mx-auto flex w-full max-w-sm items-end gap-2 px-3">
          <div className="flex min-w-0 flex-1 flex-col items-stretch gap-2">
          <AnimatePresence>
            {menuOpen && (
              <motion.div
                key="menu-sheet"
                initial={{ opacity: 0, y: 12, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.98 }}
                transition={{ type: "spring", stiffness: 380, damping: 32 }}
                className="pointer-events-auto origin-bottom border border-border/80 bg-popover/95 shadow-2xl shadow-black/20 backdrop-blur-xl supports-[backdrop-filter]:bg-popover/85 max-h-[70svh] overflow-y-auto"
              >
                <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border/70 bg-popover/95 px-4 py-3 backdrop-blur-xl supports-[backdrop-filter]:bg-popover/85">
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar className="h-9 w-9 rounded-none border border-border/70">
                      <AvatarImage src={user?.avatar_url} alt={user?.full_name ?? "User"} />
                      <AvatarFallback className="rounded-none bg-sidebar-primary text-sidebar-primary-foreground text-xs">
                        {initials}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1 text-left text-sm leading-tight">
                      <div className="truncate font-medium">{user?.full_name ?? "Signed in"}</div>
                      <div className="truncate text-xs text-muted-foreground">{user?.email ?? ""}</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label="Close menu"
                    onClick={() => setMenuOpen(false)}
                    className="flex h-9 w-9 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-4" />
                  </button>
                </div>

                {visibleMenuSections.map((section) => (
                  <div key={section.label} className="flex flex-col">
                    <div className="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {section.label}
                    </div>
                    {section.items.map((item) =>
                      item.subItems && item.subItems.length > 0 ? (
                        <MenuGroupRows key={item.title} item={item} onSelect={() => setMenuOpen(false)} />
                      ) : (
                        <MenuRow key={item.url + item.title} item={item} onSelect={() => setMenuOpen(false)} />
                      ),
                    )}
                  </div>
                ))}

                <div className="mt-2 flex flex-col border-t border-border/70">
                  {canAccessPlatform && (
                    <MenuActionLink
                      href="/platform"
                      icon={HardHat}
                      label="Platform"
                      onClick={() => setMenuOpen(false)}
                      accent
                    />
                  )}
                  <MenuActionLink
                    href={settingsHref}
                    icon={Settings}
                    label="Settings"
                    onClick={() => setMenuOpen(false)}
                  />
                  <MenuActionLink
                    href="/whats-new"
                    icon={Sparkles}
                    label="What's New"
                    badge={effectiveUnreadCount}
                    onClick={() => setMenuOpen(false)}
                  />
                  <MenuActionLink
                    href="/help"
                    icon={CircleHelp}
                    label="Help Center"
                    onClick={() => setMenuOpen(false)}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      startSignOut(async () => {
                        await signOutAction()
                      })
                    }}
                    className="flex w-full items-center gap-3 border-t border-border/70 px-4 py-3.5 text-left text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 active:bg-destructive/15"
                  >
                    <LogOut className="size-4" />
                    {signingOut ? "Signing out..." : "Log out"}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <nav
            aria-label="Primary"
            className="pointer-events-auto relative flex h-14 items-stretch border border-border/80 bg-background/85 shadow-2xl shadow-black/15 backdrop-blur-xl supports-[backdrop-filter]:bg-background/75"
          >
            {visiblePrimary.map((item) => (
              <NavTab key={item.url + item.title} item={item} />
            ))}
            <MenuToggle
              open={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              active={menuHasActive}
            />
          </nav>
          </div>
          {action ? (
            <button
              type="button"
              onClick={action.onAction}
              aria-label={action.label}
              className="pointer-events-auto flex h-14 w-14 shrink-0 items-center justify-center border border-blue-600 bg-blue-600 text-white shadow-2xl shadow-blue-600/30 transition-transform active:scale-95 hover:bg-blue-700"
            >
              <Plus className="size-6" strokeWidth={2.4} />
            </button>
          ) : null}
        </div>
      </div>
    </>
  )
}

function NavTab({ item }: { item: NavItem }) {
  const hasSubs = (item.subItems?.length ?? 0) > 0
  if (!hasSubs) {
    return <NavTabLink item={item} />
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-current={item.isActive ? "page" : undefined}
          className={cn(
            "group relative flex h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[10px] font-medium tracking-wide uppercase transition-colors data-[state=open]:text-foreground",
            item.isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground active:text-foreground",
          )}
        >
          {item.isActive && (
            <motion.span
              layoutId="mobile-nav-active"
              className="absolute inset-x-2 top-0 h-[2px] bg-primary"
              transition={{ type: "spring", stiffness: 500, damping: 40 }}
            />
          )}
          <NavTabIcon item={item} />
          <span className="truncate">{item.title}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={10}
        collisionPadding={12}
        className="w-60 max-w-[calc(100vw-1.5rem)] origin-bottom border-border/80 bg-popover/95 p-0 shadow-2xl shadow-black/20 backdrop-blur-xl supports-[backdrop-filter]:bg-popover/85"
      >
        <div className="border-b border-border/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {item.title}
        </div>
        <div className="flex flex-col py-1">
          {item.subItems!.map((sub) => (
            <SubItemRow key={sub.url + sub.title} item={sub} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function NavTabIcon({ item }: { item: NavItem }) {
  const Icon = item.icon
  return (
    <span className="relative">
      <Icon
        className={cn("size-5 transition-transform group-active:scale-90", item.isActive ? "text-primary" : "")}
        strokeWidth={item.isActive ? 2.4 : 2}
      />
      {item.badge ? (
        <span className="absolute -right-2 -top-1 flex h-4 min-w-4 items-center justify-center bg-primary px-1 text-[9px] font-semibold text-primary-foreground">
          {item.badge > 9 ? "9+" : item.badge}
        </span>
      ) : null}
    </span>
  )
}

function NavTabLink({ item }: { item: NavItem }) {
  return (
    <OptimisticLink
      href={item.url}
      aria-current={item.isActive ? "page" : undefined}
      className={cn(
        "group relative flex h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[10px] font-medium tracking-wide uppercase transition-colors",
        item.isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground active:text-foreground",
      )}
    >
      {item.isActive && (
        <motion.span
          layoutId="mobile-nav-active"
          className="absolute inset-x-2 top-0 h-[2px] bg-primary"
          transition={{ type: "spring", stiffness: 500, damping: 40 }}
        />
      )}
      <NavTabIcon item={item} />
      <span className="truncate">{item.title}</span>
    </OptimisticLink>
  )
}

function SubItemRow({ item }: { item: NavSubItem }) {
  return (
    <OptimisticLink
      href={item.url}
      aria-current={item.isActive ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 px-3 py-2.5 text-sm transition-colors active:bg-accent",
        item.isActive ? "bg-primary/10 text-primary font-medium" : "text-foreground hover:bg-accent/60",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 transition-colors",
          item.isActive ? "bg-primary" : "bg-transparent",
        )}
      />
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
    </OptimisticLink>
  )
}

function MenuToggle({
  open,
  onClick,
  active,
}: {
  open: boolean
  onClick: () => void
  active: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label={open ? "Close menu" : "Open menu"}
      className={cn(
        "group relative flex h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[10px] font-medium tracking-wide uppercase transition-colors",
        active ? "text-foreground" : open ? "text-foreground" : "text-muted-foreground hover:text-foreground active:text-foreground",
      )}
    >
      {active && (
        <motion.span
          layoutId="mobile-nav-active"
          className="absolute inset-x-2 top-0 h-[2px] bg-primary"
          transition={{ type: "spring", stiffness: 500, damping: 40 }}
        />
      )}
      <span className="relative flex h-5 w-5 items-center justify-center">
        <motion.span
          animate={{ rotate: open ? 90 : 0, opacity: open ? 0 : 1, scale: open ? 0.6 : 1 }}
          transition={{ duration: 0.18 }}
          className="absolute inset-0 flex items-center justify-center"
        >
          <MoreHorizontal
            className={cn("size-5", active ? "text-primary" : "")}
            strokeWidth={active ? 2.4 : 2}
          />
        </motion.span>
        <motion.span
          animate={{ rotate: open ? 0 : -90, opacity: open ? 1 : 0, scale: open ? 1 : 0.6 }}
          transition={{ duration: 0.18 }}
          className="absolute inset-0 flex items-center justify-center"
        >
          <X className="size-5 text-primary" strokeWidth={2.4} />
        </motion.span>
      </span>
      <span className="truncate">{open ? "Close" : "Menu"}</span>
    </button>
  )
}

function MenuRow({ item, onSelect }: { item: NavItem; onSelect: () => void }) {
  const Icon = item.icon
  return (
    <OptimisticLink
      href={item.url}
      onClick={onSelect}
      aria-current={item.isActive ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors active:bg-accent",
        item.isActive ? "bg-primary/10 text-primary" : "text-foreground hover:bg-accent/60",
      )}
    >
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center border transition-colors",
          item.isActive ? "border-primary/40 bg-primary/10 text-primary" : "border-border/70 bg-background text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
      {item.badge ? (
        <span className="flex h-5 min-w-5 items-center justify-center bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
          {item.badge > 9 ? "9+" : item.badge}
        </span>
      ) : null}
    </OptimisticLink>
  )
}

function MenuGroupRows({ item, onSelect }: { item: NavItem; onSelect: () => void }) {
  return (
    <div className="flex flex-col">
      {item.subItems!.map((sub) => (
        <OptimisticLink
          key={sub.url + sub.title}
          href={sub.url}
          onClick={onSelect}
          aria-current={sub.isActive ? "page" : undefined}
          className={cn(
            "flex items-center gap-3 px-4 py-2.5 text-sm transition-colors active:bg-accent",
            sub.isActive ? "bg-primary/10 text-primary font-medium" : "text-foreground hover:bg-accent/60",
          )}
        >
          <span
            className={cn(
              "ml-1 h-1.5 w-1.5 shrink-0 transition-colors",
              sub.isActive ? "bg-primary" : "bg-border",
            )}
          />
          <span className="min-w-0 flex-1 truncate">{sub.title}</span>
        </OptimisticLink>
      ))}
    </div>
  )
}

function MenuActionLink({
  href,
  icon: Icon,
  label,
  onClick,
  accent,
  badge,
}: {
  href: string
  icon: LucideIcon
  label: string
  onClick: () => void
  accent?: boolean
  badge?: number
}) {
  return (
    <OptimisticLink
      href={href}
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 px-4 py-3.5 text-sm font-medium transition-colors hover:bg-accent/60 active:bg-accent",
        accent ? "text-cyan-600 dark:text-cyan-400" : "text-foreground",
      )}
    >
      <Icon className="size-4" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge && badge > 0 ? (
        <span className="flex h-5 min-w-5 items-center justify-center bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
          {badge > 9 ? "9+" : badge}
        </span>
      ) : null}
    </OptimisticLink>
  )
}
