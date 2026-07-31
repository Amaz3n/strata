"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { MoreHorizontal } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export function CommunityTabs({ communityId }: { communityId: string }) {
  const pathname = usePathname()
  const base = `/communities/${communityId}`
  // Three tabs, three jobs. Inventory is every role's read of the lots; Offering
  // is the sales manager's weekly edit; Land is the land manager's phases,
  // takedowns, and runway. Settings is configure-once, so it sits in the overflow
  // rather than taking a quarter of the tab bar. Buyers, starts, and selections
  // are displayed here but mutated on Sales, Starts, and Design Studio — one
  // home per mutation.
  const tabs = [
    ["Inventory", base],
    ["Offering", `${base}/offering`],
    ["Land", `${base}/land`],
  ] as const
  const settingsHref = `${base}/settings`
  const onSettings = pathname.startsWith(settingsHref)

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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn("mb-1 h-6 w-6 rounded-none p-0", onSettings ? "text-foreground" : "text-muted-foreground")}
          >
            <MoreHorizontal className="size-4" />
            <span className="sr-only">More community actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem asChild>
            <Link href={settingsHref}>Community settings</Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  )
}
