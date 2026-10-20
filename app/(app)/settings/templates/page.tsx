import { redirect } from "next/navigation";
import { getWorkspaceSurface } from "@/lib/services/workspace-surface";
import { isTradeSurface } from "@/lib/workspace-surface";
import { TemplateLibraryLoading } from "./templates-navigation"
import { resolveTemplateSection } from "./sections"
import { connection } from "next/server";
import { Suspense } from "react";
import { WaiverTemplateLibrary } from "@/components/settings/waiver-template-library";
import { AgreementTemplateLibrary } from "@/components/settings/agreement-template-library";
import { runAction } from "@/lib/action-result";
import { listAgreementTemplates } from "@/lib/services/agreement-templates";
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
  // Waivers are the one library every company keeps, a trade included; the rest are builder starting points.
  if (section !== "waivers" && isTradeSurface(await getWorkspaceSurface())) redirect("/settings/templates?section=waivers");
  if (section === "estimates") return <EstimatesSection />;
  if (section === "budgets") return <BudgetsSection />;
  if (section === "schedules") return <SchedulesSection />;
  if (section === "checklists") return <ChecklistsSection />;
  if (section === "agreements") return <AgreementsSection />;
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

async function AgreementsSection() {
  const ctx = await requireOrgContext();
  const [result, decision, communities] = await Promise.all([
    runAction(() => listAgreementTemplates({ includeRetired: false })),
    authorize({ ...ctx, permission: "agreement_template.manage" }),
    ctx.supabase.from("communities").select("id,name,state").eq("org_id", ctx.orgId).is("archived_at", null).order("name").limit(500),
  ]);
  return (
    <AgreementTemplateLibrary
      templates={result.success ? result.data.templates : []}
      truncated={result.success ? result.data.truncated : false}
      loadError={result.success ? (communities.error ? communities.error.message : null) : result.error}
      communities={communities.data ?? []}
      canManage={decision.allowed}
    />
  );
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
