import Link from "next/link"

import { cn } from "@/lib/utils"

const SALES_TABS = [
  ["leads", "Leads"],
  ["inventory", "Inventory"],
  ["backlog", "Backlog"],
  ["closings", "Closings"],
] as const

export type SalesTab = (typeof SALES_TABS)[number][0]

export function normalizeSalesTab(value: string | undefined): SalesTab {
  return SALES_TABS.some(([key]) => key === value) ? (value as SalesTab) : "backlog"
}

export function SalesTabs({
  active,
  searchParams = {},
}: {
  active: SalesTab
  searchParams?: Record<string, string | undefined>
}) {
  return (
    <nav aria-label="Sales" className="flex h-10 items-end gap-5 overflow-x-auto border-b px-4 text-xs">
      {SALES_TABS.map(([key, label]) => {
        const params = new URLSearchParams()
        params.set("tab", key)
        for (const [name, value] of Object.entries(searchParams)) {
          if (value && name !== "tab") params.set(name, value)
        }
        return (
          <Link
            key={key}
            href={`/sales?${params}`}
            aria-current={active === key ? "page" : undefined}
            className={cn(
              "whitespace-nowrap border-b-2 pb-2.5",
              active === key
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
