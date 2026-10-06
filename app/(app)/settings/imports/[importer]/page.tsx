import { connection } from "next/server"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { notFound } from "next/navigation"

import { importNavigationSchema } from "@/lib/validation/import-navigation"
import { ImportWorkspace } from "@/components/admin/import-workspace"
import { PageLayout } from "@/components/layout/page-layout"
import { requireOrgContext } from "@/lib/services/context"
import { IMPORTER_DEFINITIONS, IMPORTER_KEYS, type ImporterKey } from "@/lib/services/import-definitions"
import { getImportBatch, listImportBatches } from "@/lib/services/imports"
import { commitOrgImportAction, discardOrgImportAction, patchOrgImportRowAction, previewOrgImportAction, setOrgImportUpdateExistingAction, stageOrgImportAction } from "../actions"


async function OrgImporterPageContent({ params, searchParams }: { params: Promise<{ importer: string }>; searchParams: Promise<{ batch?: string; batchPage?: string; rowPage?: string; rowStatus?: string }> }) {
  await connection()
  const [{ importer: rawImporter }, query, { orgId }] = await Promise.all([params, searchParams, requireOrgContext(undefined, { allowLocked: true })])
  if (!IMPORTER_KEYS.includes(rawImporter as ImporterKey) || rawImporter === "open_wip") notFound()
  const importer = rawImporter as ImporterKey
  const definition = IMPORTER_DEFINITIONS[importer]
  const navigation = importNavigationSchema.parse(query)
  const [batchesResult, detail] = await Promise.all([
    listImportBatches({ importer, limit: 25, page: navigation.batchPage }),
    query.batch ? getImportBatch(query.batch, { limit: 500, page: navigation.rowPage, status: navigation.rowStatus }, { expectedImporter: importer }) : null,
  ])
  return <PageLayout title={definition.label} breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Data imports", href: "/settings/imports" }, { label: definition.label }]}><ImportWorkspace orgId={orgId} importer={importer} label={definition.label} description={definition.description} columns={definition.columns} fileKinds={definition.fileKinds} batches={batchesResult.batches} batchPagination={batchesResult} workspaceHref={`/settings/imports/${importer}`} detail={detail} backHref="/settings/imports" previewAction={previewOrgImportAction} stageAction={stageOrgImportAction} patchAction={patchOrgImportRowAction} updateExistingAction={setOrgImportUpdateExistingAction} commitAction={commitOrgImportAction} discardAction={discardOrgImportAction} /></PageLayout>
}

export default function OrgImporterPage(props: Parameters<typeof OrgImporterPageContent>[0]) {
  return (
    <Suspense fallback={
      <PageLayout title="Data import" breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Data imports", href: "/settings/imports" }, { label: "Data import" }]}>
        <PageLoadingSkeleton />
      </PageLayout>
    }>
      <OrgImporterPageContent {...props} />
    </Suspense>
  )
}
