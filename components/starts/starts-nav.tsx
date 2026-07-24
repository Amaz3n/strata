"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/utils"

const links = [
  ["Release board", "/starts"],
  ["Pipeline", "/starts/pipeline"],
  ["Trade look-aheads", "/starts/trades"],
  ["Reports", "/starts/reports"],
  ["Gate settings", "/starts/settings"],
] as const

export function StartsNav({ attentionCount }: { attentionCount: number }) {
  const pathname = usePathname()
  return (
    <nav aria-label="Starts" className="flex h-10 items-end gap-5 overflow-x-auto border-b px-4 text-xs">
      {links.map(([label, href]) => {
        const active = href === "/starts" ? pathname === "/starts" : pathname.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-1.5 whitespace-nowrap border-b-2 pb-2.5",
              active
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:border-foreground hover:text-foreground",
            )}
          >
            {label}
            {href === "/starts/pipeline" && attentionCount > 0 ? (
              <span className="bg-destructive px-1 text-[10px] font-semibold tabular-nums leading-4 text-destructive-foreground">
                {attentionCount}
              </span>
            ) : null}
          </Link>
        )
      })}
    </nav>
  )
}
