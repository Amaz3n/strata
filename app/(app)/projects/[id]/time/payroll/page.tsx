import { connection } from "next/server";
import { Suspense } from "react";
import { PageLayout } from "@/components/layout/page-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { PayrollCorrectionWorkspace } from "@/components/time/payroll-correction-workspace";
import { PayrollDraftWorkspace } from "@/components/time/payroll-draft-workspace";
import { PayrollRegisterIntake } from "@/components/time/payroll-register-intake";
import {
  loadProjectPayrollDraftsAction,
  loadProjectPayrollDraftAction,
  loadProjectPayrollCorrectionsAction,
  loadProjectPayrollCorrectionAction,
} from "./actions";

export default function ProjectPayrollPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ source?: string; draft?: string }>;
}) {
  return (
    <Suspense
      fallback={
        <PageLayout title="Payroll">
          <Skeleton className="h-72 w-full" />
        </PageLayout>
      }
    >
      <ProjectPayrollContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}
async function ProjectPayrollContent({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ source?: string; draft?: string }>;
}) {
  await connection();
  const [{ id }, { source, draft }] = await Promise.all([params, searchParams]),
    result = await loadProjectPayrollCorrectionsAction(id);
  if (!result.success)
    return (
      <PageLayout title="Payroll">
        <p role="alert" className="rounded-md border p-4 text-sm">
          {result.error}
        </p>
      </PageLayout>
    );
  const workspace = result.data,
    selected = source
      ? await loadProjectPayrollCorrectionAction({
          projectId: id,
          sourceId: source,
        })
      : null;
  const detail = selected?.success ? selected.data : null,
    error = selected && !selected.success ? selected.error : null;
  const draftPage = await loadProjectPayrollDraftsAction(id);
  const selectedDraft = draft
    ? await loadProjectPayrollDraftAction({ projectId: id, importId: draft })
    : null;
  return (
    <PageLayout
      title="Payroll"
      breadcrumbs={[
        { label: workspace.projectName, href: `/projects/${id}` },
        { label: "Time", href: `/projects/${id}/time` },
        { label: "Payroll" },
      ]}
    >
      <div className="space-y-8">
        <PayrollRegisterIntake
          key={workspace.projectId}
          projectId={workspace.projectId}
        />
        {draftPage.success ? (
          <PayrollDraftWorkspace
            key={`${id}:${draft ?? ""}`}
            initial={draftPage.data}
            initialDetail={selectedDraft?.success ? selectedDraft.data : null}
            initialError={
              selectedDraft && !selectedDraft.success
                ? selectedDraft.error
                : null
            }
          />
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {draftPage.error}
          </p>
        )}
        <PayrollCorrectionWorkspace
          key={`${workspace.projectId}:${source ?? ""}`}
          initial={workspace}
          initialDetail={detail}
          initialError={error}
        />
      </div>
    </PageLayout>
  );
}
