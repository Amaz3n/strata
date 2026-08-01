"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"
import {
  Box,
  Building2,
  CalendarClock,
  Camera,
  CheckSquare,
  ClipboardCheck,
  ClipboardList,
  FileSignature,
  FileText,
  HelpCircle,
  Home,
  Info,
  Map,
  MoreHorizontal,
  PencilRuler,
  ReceiptText,
  ShieldCheck,
  ShoppingCart,
  Wallet,
  type LucideIcon,
} from "lucide-react"

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import type { PortalNavIcon, PortalNavItem } from "./portal-nav-items"

/**
 * Icon keys resolve to components here, on the client. The manifests are built
 * in server layouts and only serialisable data can cross that boundary, so they
 * carry keys rather than the components themselves.
 */
const NAV_ICONS: Record<PortalNavIcon, LucideIcon> = {
  home: Home,
  rfis: HelpCircle,
  submittals: FileText,
  punch: CheckSquare,
  warranty: ShieldCheck,
  "warranty-visits": CalendarClock,
  contracts: FileSignature,
  "purchase-orders": ShoppingCart,
  invoices: ReceiptText,
  "daily-logs": ClipboardList,
  compliance: ShieldCheck,
  prequalification: ClipboardCheck,
  documents: FileText,
  payments: Wallet,
  roadmap: Map,
  photos: Camera,
  approvals: CheckSquare,
  about: Info,
  overview: Building2,
  drawings: PencilRuler,
  model: Box,
}

interface PortalNavProps {
  /** Portal root, e.g. `/s/abc123`. Segments are appended to it. */
  root: string
  items: PortalNavItem[]
}

function hrefFor(root: string, segment: string) {
  return segment ? `${root}/${segment}` : root
}

/**
 * Active when the path is the item itself or a page nested beneath it, so a
 * detail route like `/s/:token/bills/123` keeps Invoices lit. The root only
 * matches exactly, otherwise it would win everywhere.
 */
function useIsActive(root: string, segment: string) {
  const pathname = usePathname()
  const href = hrefFor(root, segment)
  if (!segment) return pathname === root
  return pathname === href || pathname.startsWith(`${href}/`)
}

function CountBadge({ count }: { count: number }) {
  return (
    <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center bg-destructive px-1.5 text-[11px] font-semibold tabular-nums text-destructive-foreground">
      {count > 99 ? "99+" : count}
    </span>
  )
}

function DesktopNavLink({ root, item }: { root: string; item: PortalNavItem }) {
  const isActive = useIsActive(root, item.segment)
  const Icon = NAV_ICONS[item.icon]

  return (
    <Link
      href={hrefFor(root, item.segment)}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 border-l-2 px-3 py-2 text-sm transition-colors duration-150",
        isActive
          ? "border-l-primary bg-primary/8 font-medium text-foreground"
          : "border-l-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
      {item.count ? <CountBadge count={item.count} /> : null}
    </Link>
  )
}

function MobileNavLink({
  root,
  item,
  onNavigate,
}: {
  root: string
  item: PortalNavItem
  onNavigate?: () => void
}) {
  const isActive = useIsActive(root, item.segment)
  const Icon = NAV_ICONS[item.icon]

  return (
    <Link
      href={hrefFor(root, item.segment)}
      onClick={onNavigate}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "relative flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] transition-colors",
        isActive ? "text-primary" : "text-muted-foreground",
      )}
    >
      <span className="relative">
        <Icon className="size-5" />
        {item.count ? (
          <span className="absolute -right-2 -top-1 inline-flex h-4 min-w-4 items-center justify-center bg-destructive px-1 text-[10px] font-semibold tabular-nums text-destructive-foreground">
            {item.count > 9 ? "9+" : item.count}
          </span>
        ) : null}
      </span>
      <span className="max-w-full truncate px-1">{item.shortLabel ?? item.label}</span>
    </Link>
  )
}

/** Sticky left rail. Hidden below `md`, where the bottom bar takes over. */
export function PortalSideNav({ root, items }: PortalNavProps) {
  return (
    <nav aria-label="Portal sections" className="hidden w-60 shrink-0 md:block">
      <div className="sticky top-[var(--portal-header-height)] flex flex-col gap-0.5 py-6 pr-4">
        {items.map((item) => (
          <DesktopNavLink key={item.segment || "home"} root={root} item={item} />
        ))}
      </div>
    </nav>
  )
}

/**
 * Fixed bottom bar. Shows up to four primary destinations plus a More sheet
 * holding everything, so the bar never crowds regardless of permission mix.
 */
export function PortalBottomNav({ root, items }: PortalNavProps) {
  const [open, setOpen] = useState(false)
  const primary = items.filter((item) => item.primary).slice(0, 4)
  const overflow = items.filter((item) => !primary.includes(item))
  const overflowCount = overflow.reduce((sum, item) => sum + (item.count ?? 0), 0)

  return (
    <nav
      aria-label="Portal sections"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="flex items-stretch">
        {primary.map((item) => (
          <MobileNavLink key={item.segment || "home"} root={root} item={item} />
        ))}

        {overflow.length > 0 ? (
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger
              className={cn(
                "relative flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px]",
                "text-muted-foreground transition-colors",
              )}
            >
              <span className="relative">
                <MoreHorizontal className="size-5" />
                {overflowCount > 0 ? (
                  <span className="absolute -right-2 -top-1 inline-flex h-4 min-w-4 items-center justify-center bg-destructive px-1 text-[10px] font-semibold tabular-nums text-destructive-foreground">
                    {overflowCount > 9 ? "9+" : overflowCount}
                  </span>
                ) : null}
              </span>
              <span>More</span>
            </SheetTrigger>
            <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
              <SheetHeader className="text-left">
                <SheetTitle>All sections</SheetTitle>
              </SheetHeader>
              <div className="grid grid-cols-3 gap-2 px-4 pb-6">
                {items.map((item) => {
                  const Icon = NAV_ICONS[item.icon]
                  return (
                    <Link
                      key={item.segment || "home"}
                      href={hrefFor(root, item.segment)}
                      onClick={() => setOpen(false)}
                      className="flex flex-col items-center gap-2 border border-border p-3 text-center text-xs transition-colors hover:bg-muted"
                    >
                      <span className="relative">
                        <Icon className="size-5 text-muted-foreground" />
                        {item.count ? (
                          <span className="absolute -right-2 -top-1 inline-flex h-4 min-w-4 items-center justify-center bg-destructive px-1 text-[10px] font-semibold tabular-nums text-destructive-foreground">
                            {item.count > 9 ? "9+" : item.count}
                          </span>
                        ) : null}
                      </span>
                      <span className="leading-tight">{item.label}</span>
                    </Link>
                  )
                })}
              </div>
            </SheetContent>
          </Sheet>
        ) : null}
      </div>
    </nav>
  )
}
