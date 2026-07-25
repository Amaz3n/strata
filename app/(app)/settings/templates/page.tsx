import Link from "next/link"

import { PageLayout } from "@/components/layout/page-layout"
import { BudgetTemplatesClient } from "@/components/financials/budget-templates-client"
import { EstimateTemplatesClient } from "@/components/estimates/estimate-templates-client"
import { ScheduleTemplatesClient } from "@/components/schedule/schedule-templates-client"
import { listBudgetTemplates } from "@/lib/services/budget-templates"
import { listChecklistTemplates } from "@/lib/services/inspections"
import { listTemplates } from "@/lib/services/schedule"
import { cn } from "@/lib/utils"

import { listCostCodesAction } from "../cost-codes/actions"
import { ChecklistsClient } from "./checklists-client"
import { listEstimateTemplatesAction } from "./actions"

export const dynamic = "force-dynamic"

const SECTIONS = [
  { key: "estimates", label: "Estimates", description: "Reusable sections and line items to start a new estimate from. Terms, cover note, and branding live in Organization." },
  { key: "budgets", label: "Budgets", description: "Reusable budget lines with fixed amounts or quantity-based costs." },
  { key: "schedules", label: "Schedules", description: "Reusable activities with calendar-day start offsets and durations." },
  { key: "checklists", label: "Checklists", description: "Safety and quality checklists used to run inspections. Running inspections snapshot their items, so edits never change past inspections." },
] as const

type SectionKey = (typeof SECTIONS)[number]["key"]

function resolveSection(value?: string): SectionKey {
  return SECTIONS.some((section) => section.key === value) ? (value as SectionKey) : "estimates"
}

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ section?: string }> }) {
  const section = resolveSection((await searchParams).section)
  const active = SECTIONS.find((entry) => entry.key === section) ?? SECTIONS[0]

  return (
    <PageLayout title="Templates" breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Templates" }]}>
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Templates</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{active.description}</p>
        </div>

        <nav className="flex items-center gap-1 border-b border-border">
          {SECTIONS.map((entry) => (
            <Link
              key={entry.key}
              href={`/settings/templates?section=${entry.key}`}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
                entry.key === section
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {entry.label}
            </Link>
          ))}
        </nav>

        {section === "estimates" ? <EstimatesSection /> : null}
        {section === "budgets" ? <BudgetsSection /> : null}
        {section === "schedules" ? <SchedulesSection /> : null}
        {section === "checklists" ? <ChecklistsSection /> : null}
      </div>
    </PageLayout>
  )
}

async function EstimatesSection() {
  const [templates, costCodes] = await Promise.all([listEstimateTemplatesAction(), listCostCodesAction(true)])
  return <EstimateTemplatesClient initialTemplates={templates} costCodes={costCodes} />
}

async function BudgetsSection() {
  const [budgetTemplates, costCodes] = await Promise.all([listBudgetTemplates().catch(() => []), listCostCodesAction(true)])
  return <BudgetTemplatesClient initialTemplates={budgetTemplates} costCodes={costCodes} />
}

async function SchedulesSection() {
  const scheduleTemplates = await listTemplates().catch(() => [])
  return <ScheduleTemplatesClient initialTemplates={scheduleTemplates} />
}

async function ChecklistsSection() {
  const templates = await listChecklistTemplates(undefined, { includeInactive: true })
  return <ChecklistsClient templates={templates} />
}
