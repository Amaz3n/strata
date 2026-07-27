"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/utils"

export function CommunityTabs({ communityId }: { communityId: string }) {
  const pathname = usePathname()
  const base = `/communities/${communityId}`
  // Three tabs, three jobs. The plat carries land, price, buyer, and money for
  // every lot, so P&L is a lens on it rather than a tab; phases, takedowns, and
  // assignments are how the container is configured, so they live in Settings.
  // Holds and traffic belong to the consultant on /sales, not here.
  const tabs = [
    ["Lots", base],
    ["Offering", `${base}/offering`],
    ["Settings", `${base}/settings`],
  ] as const

  return (
    <nav aria-label="Community" className="flex h-10 items-end gap-5 overflow-x-auto text-xs">
      {tabs.map(([label, href]) => {
        const active = href === base ? pathname === base : pathname.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "whitespace-nowrap border-b-2 pb-2.5",
              active
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:border-foreground hover:text-foreground",
            )}
          >
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
