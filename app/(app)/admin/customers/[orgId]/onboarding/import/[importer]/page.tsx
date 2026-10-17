import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import { connection } from "next/server"

import { importNavigationSchema } from "@/lib/validation/import-navigation"
import { ImportWorkspace } from "@/components/admin/import-workspace"
import { PageLayout } from "@/components/layout/page-layout"
import { IMPORTER_DEFINITIONS, IMPORTER_KEYS, type ImporterKey } from "@/lib/services/import-definitions"
import { getImportBatch, listImportBatches } from "@/lib/services/imports"
import { hasAnyPlatformPermission } from "@/lib/services/platform-access"
import { getOnboardingRun } from "@/lib/services/onboarding"
import { cancelImportAction, commitImportAction, discardImportAction, patchImportRowAction, previewImportAction, setImportUpdateExistingAction, stageImportAction } from "../../actions"


async function ImporterPageContent({ params, searchParams }: { params: Promise<{ orgId: string; importer: string }>; searchParams: Promise<{ batch?: string; batchPage?: string; rowPage?: string; rowStatus?: string }> }) {
  await connection()
  const [{ orgId, importer: rawImporter }, query] = await Promise.all([params, searchParams])
  if (!IMPORTER_KEYS.includes(rawImporter as ImporterKey)) notFound()
  const importer = rawImporter as ImporterKey
  const definition = IMPORTER_DEFINITIONS[importer]
  const navigation = importNavigationSchema.parse(query)
  const onboardingPromise = getOnboardingRun(orgId).then((onboarding) => {
    if (!onboarding.run) notFound()
    return { ...onboarding, run: onboarding.run }
  })
  const detailPromise = onboardingPromise.then(() =>
    query.batch ? getImportBatch(query.batch, { limit: 500, page: navigation.rowPage, status: navigation.rowStatus }, { platformOrgId: orgId, expectedImporter: importer }) : null,
  )
  const [onboarding, batchesResult, detail, canManage] = await Promise.all([
    onboardingPromise,
    listImportBatches({ importer, limit: 25, page: navigation.batchPage }, { platformOrgId: orgId }),
    detailPromise,
    hasAnyPlatformPermission(["platform.support.write"]),
  ])

  async function preview(input: { orgId?: string; importer: ImporterKey; csvText: string }) { "use server"; return previewImportAction({ orgId, importer: input.importer, csvText: input.csvText }) }
  async function stage(input: { orgId?: string; importer: ImporterKey; csvText: string; sourceFilename?: string; mapping: Record<string, string | null>; context?: Record<string, unknown>; onboardingRunId?: string | null }) { "use server"; return stageImportAction({ ...input, orgId }) }
  async function patch(input: { orgId?: string; importer: ImporterKey; batchId: string; rowId: string; patch?: Record<string, string | number | boolean | null>; skip?: boolean }) { "use server"; return patchImportRowAction({ ...input, orgId }) }
  async function updateExisting(input: { orgId?: string; importer: ImporterKey; batchId: string; updateExisting: boolean }) { "use server"; return setImportUpdateExistingAction({ ...input, orgId }) }
  async function commit(input: { orgId?: string; importer: ImporterKey; batchId: string }) { "use server"; return commitImportAction({ ...input, orgId }) }
  async function cancel(input: { orgId?: string; importer: ImporterKey; batchId: string }) { "use server"; return cancelImportAction({ ...input, orgId }) }
  async function discard(input: { orgId?: string; importer: ImporterKey; batchId: string }) { "use server"; return discardImportAction({ ...input, orgId }) }

  return <PageLayout title={definition.label} breadcrumbs={[{ label: "Admin", href: "/admin" }, { label: "Customers", href: "/admin/customers" }, { label: onboarding.org.name, href: `/admin/customers/${orgId}/onboarding` }, { label: definition.label }]}><ImportWorkspace canManage={canManage} orgId={orgId} onboardingRunId={onboarding.run.id} importer={importer} label={definition.label} description={definition.description} columns={definition.columns} fileKinds={definition.fileKinds} batches={batchesResult.batches} batchPagination={batchesResult} workspaceHref={`/admin/customers/${orgId}/onboarding/import/${importer}`} detail={detail} backHref={`/admin/customers/${orgId}/onboarding`} previewAction={preview} stageAction={stage} patchAction={patch} updateExistingAction={updateExisting} commitAction={commit} discardAction={discard} cancelAction={importer === "open_wip" ? cancel : undefined} /></PageLayout>
}

export default function ImporterPage(props: Parameters<typeof ImporterPageContent>[0]) {
  return (
    <Suspense fallback={
      <PageLayout title="Data import" breadcrumbs={[{ label: "Admin", href: "/admin" }, { label: "Customers", href: "/admin/customers" }, { label: "Data import" }]}>
        <PageLoadingSkeleton />
      </PageLayout>
    }>
      <ImporterPageContent {...props} />
    </Suspense>
  )
}
