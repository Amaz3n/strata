import { Suspense } from "react"
import Link from "next/link"

import { PageLayout } from "@/components/layout/page-layout"
import { CostCodeManager } from "@/components/cost-codes/cost-code-manager"
import { CostCodesEnabledSwitch } from "@/components/cost-codes/cost-codes-enabled-switch"
import { DollarSign, Percent, Tag } from "@/components/icons"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

import { listCostCodesAction } from "../cost-codes/actions"
import { getCostCodingSettingsAction } from "./actions"
import { BillingRatesSection } from "./billing-rates-section"
import { MarkupRulesSection } from "./markup-rules-section"

export const dynamic = "force-dynamic"

const SECTIONS = [
  { key: "codes", label: "Cost codes", icon: Tag },
  { key: "markup", label: "Markup rules", icon: Percent },
  { key: "rates", label: "Billing rates", icon: DollarSign },
] as const

type SectionKey = (typeof SECTIONS)[number]["key"]

function resolveSection(value?: string): SectionKey {
  return SECTIONS.some((section) => section.key === value) ? (value as SectionKey) : "codes"
}

export default async function CostCodingPage({ searchParams }: { searchParams: Promise<{ section?: string }> }) {
  const section = resolveSection((await searchParams).section)

  return (
    <PageLayout fullBleed title="Cost coding" breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Cost coding" }]}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <nav className="flex shrink-0 items-center gap-5 border-b border-border px-4">
          {SECTIONS.map((entry) => {
            const active = entry.key === section
            return (
              <Link
                key={entry.key}
                href={`/settings/cost-coding?section=${entry.key}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px flex items-center gap-1.5 border-b-2 py-2.5 text-sm transition-colors",
                  active
                    ? "border-foreground font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <entry.icon className="size-3.5" />
                {entry.label}
              </Link>
            )
          })}
        </nav>

        <div className="min-h-0 flex-1 overflow-hidden">
          {section === "codes" ? (
            <Suspense fallback={<RosterSkeleton />}>
              <CostCodesSection />
            </Suspense>
          ) : null}
          {section === "markup" ? (
            <Suspense fallback={<RosterSkeleton />}>
              <MarkupRulesSection />
            </Suspense>
          ) : null}
          {section === "rates" ? (
            <Suspense fallback={<RosterSkeleton />}>
              <BillingRatesSection />
            </Suspense>
          ) : null}
        </div>
      </div>
    </PageLayout>
  )
}

async function CostCodesSection() {
  const [costCodes, settings] = await Promise.all([listCostCodesAction(true), getCostCodingSettingsAction()])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <CostCodesEnabledSwitch initialEnabled={settings.costCodesEnabled} canManage={settings.canManage} />
      <div className="min-h-0 flex-1 overflow-hidden">
        <CostCodeManager costCodes={costCodes} canManage={settings.canManage} />
      </div>
    </div>
  )
}

function RosterSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <Skeleton className="h-8 w-64" />
        <div className="flex-1" />
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="flex-1 space-y-px overflow-hidden p-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-11 w-full" />
        ))}
      </div>
    </div>
  )
}
