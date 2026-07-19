import { PageLayout } from "@/components/layout/page-layout";
import { unwrapAction } from "@/lib/action-result";

export const dynamic = "force-dynamic";
import { EstimateTemplatesClient } from "@/components/estimates/estimate-templates-client";
import { BudgetTemplatesClient } from "@/components/financials/budget-templates-client";
import { listEstimateTemplatesAction } from "./actions";
import { listCostCodesAction } from "../cost-codes/actions";
import { listBudgetTemplates } from "@/lib/services/budget-templates";
import { listTemplates } from "@/lib/services/schedule";
import { ScheduleTemplatesClient } from "@/components/schedule/schedule-templates-client";

export default async function EstimateTemplatesPage() {
  const [templates, budgetTemplates, scheduleTemplates, costCodes] =
    await Promise.all([
      listEstimateTemplatesAction(),
      listBudgetTemplates().catch(() => []),
      listTemplates().catch(() => []),
      listCostCodesAction(true),
    ]);

  return (
    <PageLayout
      title="Templates"
      breadcrumbs={[
        { label: "Settings", href: "/settings" },
        { label: "Templates" },
      ]}
    >
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">Estimate Templates</h1>
          <p className="text-muted-foreground text-sm">
            Reusable sections and line items to start a new estimate from.
            Terms, cover note, and branding are set in Settings → Organization
            and apply automatically.
          </p>
        </div>
        <EstimateTemplatesClient
          initialTemplates={templates}
          costCodes={costCodes}
        />
        <div className="border-t pt-6">
          <div className="mb-4 space-y-1">
            <h2 className="text-xl font-bold">Budget Templates</h2>
            <p className="text-sm text-muted-foreground">
              Reusable budget lines with fixed amounts or quantity-based costs.
            </p>
          </div>
          <BudgetTemplatesClient
            initialTemplates={budgetTemplates}
            costCodes={costCodes}
          />
        </div>
        <div className="border-t pt-6">
          <div className="mb-4 space-y-1">
            <h2 className="text-xl font-bold">Schedule Templates</h2>
            <p className="text-sm text-muted-foreground">
              Reusable activities with calendar-day start offsets and durations.
            </p>
          </div>
          <ScheduleTemplatesClient initialTemplates={scheduleTemplates} />
        </div>
      </div>
    </PageLayout>
  );
}
