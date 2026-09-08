import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { WaiverTemplateLibrary } from "@/components/settings/waiver-template-library";
import { listCompanyWaiverTemplates } from "./waiver-actions";
import { requireOrgContext } from "@/lib/services/context";
import { authorize } from "@/lib/services/authorization";

import { PageLayout } from "@/components/layout/page-layout";
import { BudgetTemplatesClient } from "@/components/financials/budget-templates-client";
import { EstimateTemplatesClient } from "@/components/estimates/estimate-templates-client";
import { ScheduleTemplatesClient } from "@/components/schedule/schedule-templates-client";
import { listBudgetTemplates } from "@/lib/services/budget-templates";
import { listChecklistTemplates } from "@/lib/services/inspections";
import { listTemplates } from "@/lib/services/schedule";
import { cn } from "@/lib/utils";

import { listCostCodesAction } from "../cost-codes/actions";
import { ChecklistsClient } from "./checklists-client";
import { listEstimateTemplatesAction } from "./actions";

const SECTIONS = [
  {
    key: "waivers",
    label: "Waivers",
    description: "Company documents that are ready for every project.",
  },
  {
    key: "estimates",
    label: "Estimates",
    description:
      "Reusable sections and line items to start a new estimate from. Terms, cover note, and branding live in Organization.",
  },
  {
    key: "budgets",
    label: "Budgets",
    description:
      "Reusable budget lines with fixed amounts or quantity-based costs.",
  },
  {
    key: "schedules",
    label: "Schedules",
    description:
      "Reusable activities with calendar-day start offsets and durations.",
  },
  {
    key: "checklists",
    label: "Checklists",
    description:
      "Safety and quality checklists used to run inspections. Running inspections snapshot their items, so edits never change past inspections.",
  },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

function resolveSection(value?: string): SectionKey {
  return SECTIONS.some((section) => section.key === value)
    ? (value as SectionKey)
    : "waivers";
}

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  // Organization template data is request-scoped; initialize auth after the prerender boundary.
  await connection();
  const section = resolveSection((await searchParams).section);
  const active = SECTIONS.find((entry) => entry.key === section) ?? SECTIONS[0];

  return (
    <PageLayout
      title="Templates"
      breadcrumbs={[
        { label: "Settings", href: "/settings" },
        { label: "Templates" },
      ]}
    >
      <div className="mx-auto max-w-[1440px] py-4">
        <div className="mb-10 flex items-end justify-between border-b pb-8">
          <div>
            <p className="mb-3 text-[10px] font-medium uppercase tracking-[.2em] text-muted-foreground">
              Your company’s starting points
            </p>
            <h1 className="text-3xl font-medium tracking-tight">Templates</h1>
            <p className="mt-3 text-sm text-muted-foreground">
              Set it up once. Make it yours every time.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] gap-10">
          <nav aria-label="Template categories" className="space-y-1">
            <p className="px-3 pb-3 text-[10px] uppercase tracking-widest text-muted-foreground">
              Library
            </p>
            {SECTIONS.map((entry) => (
              <Link
                key={entry.key}
                href={`/settings/templates?section=${entry.key}`}
                aria-current={entry.key === section ? "page" : undefined}
                className={cn(
                  "block rounded-md px-3 py-2.5 text-sm transition-colors",
                  entry.key === section
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                {entry.label}
              </Link>
            ))}
          </nav>
          <section className="min-w-0">
            {section !== "waivers" && (
              <div className="mb-6">
                <h2 className="text-lg font-medium">{active.label}</h2>
                <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                  {active.description}
                </p>
              </div>
            )}
            {section === "waivers" ? (
              <Suspense
                fallback={
                  <p className="py-12 text-sm text-muted-foreground">
                    Loading your library…
                  </p>
                }
              >
                <WaiversSection />
              </Suspense>
            ) : null}
            {section === "estimates" ? <EstimatesSection /> : null}
            {section === "budgets" ? <BudgetsSection /> : null}
            {section === "schedules" ? <SchedulesSection /> : null}
            {section === "checklists" ? <ChecklistsSection /> : null}
          </section>
        </div>
      </div>
    </PageLayout>
  );
}

async function EstimatesSection() {
  const [templates, costCodes] = await Promise.all([
    listEstimateTemplatesAction(),
    listCostCodesAction(true),
  ]);
  return (
    <EstimateTemplatesClient
      initialTemplates={templates}
      costCodes={costCodes}
    />
  );
}

async function BudgetsSection() {
  const [budgetTemplates, costCodes] = await Promise.all([
    listBudgetTemplates().catch(() => []),
    listCostCodesAction(true),
  ]);
  return (
    <BudgetTemplatesClient
      initialTemplates={budgetTemplates}
      costCodes={costCodes}
    />
  );
}

async function SchedulesSection() {
  const scheduleTemplates = await listTemplates().catch(() => []);
  return <ScheduleTemplatesClient initialTemplates={scheduleTemplates} />;
}

async function ChecklistsSection() {
  const templates = await listChecklistTemplates(undefined, {
    includeInactive: true,
  });
  return <ChecklistsClient templates={templates} />;
}

async function WaiversSection() {
  const ctx = await requireOrgContext();
  const [templates, decision] = await Promise.all([
    listCompanyWaiverTemplates(),
    authorize({ ...ctx, permission: "org.admin" }),
  ]);
  return (
    <WaiverTemplateLibrary
      initialTemplates={templates}
      canManage={decision.allowed}
    />
  );
}
