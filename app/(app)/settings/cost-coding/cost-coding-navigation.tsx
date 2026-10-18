"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Suspense, type ReactNode } from "react"
import { DollarSign, Percent, Tag } from "@/components/icons"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { COST_CODING_SECTIONS, resolveCostCodingSection } from "./sections"

const ICONS = { codes: Tag, markup: Percent, rates: DollarSign }

export function CostCodingNavigation({ children }: { children: ReactNode }) {
  const section = resolveCostCodingSection(useSearchParams().get("section"))
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <nav aria-label="Cost coding sections" className="flex shrink-0 items-center gap-5 border-b border-border px-4">
        {COST_CODING_SECTIONS.map(entry => {
          const active = entry.key === section
          const Icon = ICONS[entry.key]
          return (
            <Link key={entry.key} href={`/settings/cost-coding?section=${entry.key}`} prefetch
              aria-current={active ? "page" : undefined}
              className={cn("-mb-px flex items-center gap-1.5 border-b-2 py-2.5 text-sm transition-colors", active ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
            >
              <Icon className="size-3.5" />{entry.label}
            </Link>
          )
        })}
      </nav>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense key={section} fallback={<CostCodingRosterSkeleton />}>{children}</Suspense>
      </div>
    </div>
  )
}

export function CostCodingRosterSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col" role="status" aria-label="Loading cost coding" aria-busy="true">
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <Skeleton className="h-8 w-64" /><div className="flex-1" /><Skeleton className="h-8 w-28" />
      </div>
      <div className="flex-1 space-y-px overflow-hidden p-4">
        {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-11 w-full" />)}
      </div>
    </div>
  )
}
