import { TemplateLibraryLoading } from "./templates-navigation"
import { resolveTemplateSection } from "./sections"
import { connection } from "next/server";
import { Suspense } from "react";
import { WaiverTemplateLibrary } from "@/components/settings/waiver-template-library";
import { listCompanyWaiverTemplates } from "./waiver-actions";
import { requireOrgContext } from "@/lib/services/context";
import { authorize } from "@/lib/services/authorization";

import { BudgetTemplatesClient } from "@/components/financials/budget-templates-client";
import { EstimateTemplatesClient } from "@/components/estimates/estimate-templates-client";
import { ScheduleTemplatesClient } from "@/components/schedule/schedule-templates-client";
import { listBudgetTemplates } from "@/lib/services/budget-templates";
import { listChecklistTemplates } from "@/lib/services/inspections";
import { listTemplates } from "@/lib/services/schedule";

import { listCostCodesAction } from "../cost-codes/actions";
import { ChecklistsClient } from "./checklists-client";
import { listEstimateTemplatesAction } from "./actions";

async function TemplatesPageContent({ searchParams }: { searchParams: Promise<{ section?: string }> }) {
  await connection();
  const section = resolveTemplateSection((await searchParams).section);
  if (section === "estimates") return <EstimatesSection />;
  if (section === "budgets") return <BudgetsSection />;
  if (section === "schedules") return <SchedulesSection />;
  if (section === "checklists") return <ChecklistsSection />;
  return <WaiversSection />;
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
    listBudgetTemplates(),
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
  const scheduleTemplates = await listTemplates();
  return <ScheduleTemplatesClient initialTemplates={scheduleTemplates} />;
}

async function ChecklistsSection() {
  const ctx = await requireOrgContext();
  const [templates, writeDecision, seedDecision] = await Promise.all([
    listChecklistTemplates(undefined, { includeInactive: true }),
    authorize({ ...ctx, permission: "inspection.write" }),
    authorize({ ...ctx, permission: "org.admin" }),
  ]);
  return <ChecklistsClient templates={templates} canManage={writeDecision.allowed} canSeed={seedDecision.allowed} />;
}

async function WaiversSection() {
  const ctx = await requireOrgContext();
  const [templates, decision, projects] = await Promise.all([
    listCompanyWaiverTemplates(),
    authorize({ ...ctx, permission: "org.admin" }),
    ctx.supabase.from("projects").select("id,name").eq("org_id", ctx.orgId).order("name").limit(500),
  ]);
  return (
    <WaiverTemplateLibrary
      initialTemplates={templates}
      orgId={ctx.orgId}
      projects={projects.data ?? []}
      canManage={decision.allowed}
    />
  );
}

export default function TemplatesPage(props: Parameters<typeof TemplatesPageContent>[0]) {
  return (
    <Suspense fallback={<TemplateLibraryLoading />}>
      <TemplatesPageContent {...props} />
    </Suspense>
  )
}

export const maxDuration = 180;
