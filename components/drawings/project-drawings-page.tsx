import { guardProjectTab } from "@/lib/services/workspace-surface";
import { connection } from "next/server";
import { resolveMeasurementContext } from "@/lib/services/measurement-context";
import { ImportPlanFile } from "@/components/precon/import-plan-file";
import { getFileAction } from "@/app/(app)/documents/actions";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PageLayout } from "@/components/layout/page-layout";
import { DrawingsSetsView } from "@/components/drawings";
import { getProjectAction } from "@/app/(app)/projects/[id]/actions";
import {
  countDrawingSheets,
  listDrawingSets,
  listDrawingSheetsWithUrls,
} from "@/lib/services/drawings";
import { hasPermission } from "@/lib/services/permissions";
import { getOrgProductTier } from "@/lib/services/context";
import { getProjectPosture } from "@/lib/product-tier";
import { isProjectModelEnabled } from "@/lib/project-model-access";
import type { FloorplanTarget } from "@/lib/services/floorplan-models";

type DrawingsProject = NonNullable<
  Awaited<ReturnType<typeof getProjectAction>>
>;

// The register renders every sheet it is given, grouped by discipline. This is
// the ceiling; countDrawingSheets tells the view when it truncated so the cap
// is never silent.
const SHEET_RENDER_CAP = 1000;

type DrawingsQuery = Promise<{
  set?: string;
  sheetId?: string;
  condition?: string;
  planVersion?: string;
  sourceFile?: string;
  estimate?: string;
  destination?: string; target?: string; takeoff?: string; view?: string; modelView?: string;
}>;

interface ProjectDrawingsPageProps {
  params: Promise<{ id: string }>;
  searchParams: DrawingsQuery;
}

function DrawingsSkeleton() {
  return (
    <div className="space-y-4 p-6" role="status" aria-label="Loading drawings">
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-40" />)}
      </div>
    </div>
  );
}

export default function ProjectDrawingsPage(props: ProjectDrawingsPageProps) {
  return (
    <Suspense fallback={
      <PageLayout title="Drawings">
        <DrawingsSkeleton />
      </PageLayout>
    }>
      <ProjectDrawingsRoute {...props} />
    </Suspense>
  );
}

async function ProjectDrawingsRoute({
  params,
  searchParams,
}: ProjectDrawingsPageProps) {
  await connection();
  const { id } = await params;
  await guardProjectTab(id, "drawings");
  const project = await getProjectAction(id);

  if (!project) {
    notFound();
  }

  return (
    <PageLayout
      fullBleed={project.phase === "precon"}
      title={project.phase === "precon" ? "Plans & quantities" : "Drawings"}
      breadcrumbs={[
        {
          label: project.name,
          href: `/projects/${project.id}`,
        },
        { label: project.phase === "precon" ? "Plans & quantities" : "Drawings" },
      ]}
    >
      <Suspense
        fallback={
          <div className="p-6 space-y-4">
            <Skeleton className="h-8 w-48 mb-6" />
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-md" />
              ))}
            </div>
          </div>
        }
      >
        <ProjectDrawingsData
          id={id}
          project={project}
          searchParams={searchParams}
        />
      </Suspense>
    </PageLayout>
  );
}

async function ProjectDrawingsData({
  id,
  project,
  searchParams,
}: {
  id: string;
  project: DrawingsProject;
  searchParams: DrawingsQuery;
}) {
  const query = await searchParams;
  const measurementContext = await resolveMeasurementContext(id, query);
  const sourceFile = query.sourceFile
    ? await getFileAction(query.sourceFile)
    : null;
  const canImport =
    sourceFile?.project_id === id &&
    sourceFile.mime_type === "application/pdf" &&
    (await hasPermission("drawing.upload"));

  const [sets, sheets, totalSheetCount, canWriteTakeoff, canWriteModel, orgTier] = await Promise.all([
    listDrawingSets({ project_id: id, limit: 100 }),
    listDrawingSheetsWithUrls({ project_id: id, limit: SHEET_RENDER_CAP }),
    countDrawingSheets({ project_id: id }),
    // Read-only viewers still see measured quantities; only writing is gated.
    hasPermission("takeoff.write"),
    hasPermission("plan.write"),
    getOrgProductTier(),
  ]);

  // The 3D model belongs to whatever the drawings describe: a plan version
  // when measuring a plan, the project itself for a custom home. A production
  // lot's drawings ARE its plan's, so it never gets a second model.
  const planVersionId = query.planVersion;
  const production = getProjectPosture(project.property_type, orgTier) === "production";
  const modelEnabled = isProjectModelEnabled(project.org_id);
  const modelTarget: FloorplanTarget | null = !modelEnabled
    ? null
    : planVersionId
      ? { kind: "plan", housePlanVersionId: planVersionId }
      : production
        ? null
        : { kind: "project", projectId: id };
  const modelUnavailable =
    modelEnabled && !modelTarget && production
      ? { message: "This lot is built to a house plan, and the plan carries the one 3D model every lot shares.", href: "/plans", linkLabel: "Open plans" }
      : null;
  const initialView = modelEnabled && (query.view === "3d" || query.view === "split") ? query.view : undefined;

  const initialSelectedSetId =
    query.set && sets.some((set) => set.id === query.set)
      ? query.set
      : undefined;

  return (
    <div
      className={
        project.phase === "precon"
          ? "flex min-h-0 w-full flex-1"
          : "-m-4 -mt-6 h-[calc(100vh-3.5rem)]"
      }
    >
      <div className="flex min-h-0 w-full flex-col gap-4">
        {sourceFile && canImport && (
          <ImportPlanFile
            projectId={id}
            fileId={sourceFile.id}
            fileName={sourceFile.file_name}
          />
        )}
        <DrawingsSetsView
          measurementContext={measurementContext}
          estimateId={query.estimate}
          preconstruction={project.phase === "precon"}
          initialSets={sets}
          initialSheets={sheets}
          totalSheetCount={totalSheetCount}
          selectedProjectId={project.id}
          initialSelectedSetId={initialSelectedSetId}
          initialSheetId={query.sheetId}
          canWriteTakeoff={canWriteTakeoff}
          initialConditionId={query.condition}
          takeoffPlanVersionId={planVersionId}
          modelTarget={modelTarget}
          modelUnavailable={modelUnavailable}
          canWriteModel={canWriteModel}
          initialView={initialView}
          initialModelViewId={query.modelView ?? null}
        />
      </div>
    </div>
  );
}
