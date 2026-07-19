import { notFound } from "next/navigation"

import { ImportWorkspace } from "@/components/admin/import-workspace"
import { PageLayout } from "@/components/layout/page-layout"
import { IMPORTER_DEFINITIONS, IMPORTER_KEYS, type ImporterKey } from "@/lib/services/import-definitions"
import { getImportBatch, listImportBatches } from "@/lib/services/imports"
import { commitOrgImportAction, discardOrgImportAction, patchOrgImportRowAction, previewOrgImportAction, setOrgImportUpdateExistingAction, stageOrgImportAction } from "../actions"

export const dynamic = "force-dynamic"

export default async function OrgImporterPage({ params, searchParams }: { params: Promise<{ importer: string }>; searchParams: Promise<{ batch?: string }> }) {
  const [{ importer: rawImporter }, query] = await Promise.all([params, searchParams])
  if (!IMPORTER_KEYS.includes(rawImporter as ImporterKey) || rawImporter === "open_wip") notFound()
  const importer = rawImporter as ImporterKey
  const definition = IMPORTER_DEFINITIONS[importer]
  const batchesResult = await listImportBatches({ importer, limit: 25 })
  const detail = query.batch ? await getImportBatch(query.batch, { limit: 500 }) : null
  return <PageLayout title={definition.label} breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Data imports", href: "/settings/imports" }, { label: definition.label }]}><ImportWorkspace importer={importer} label={definition.label} description={definition.description} columns={definition.columns} fileKinds={definition.fileKinds} batches={batchesResult.batches} detail={detail} backHref="/settings/imports" previewAction={previewOrgImportAction} stageAction={stageOrgImportAction} patchAction={patchOrgImportRowAction} updateExistingAction={setOrgImportUpdateExistingAction} commitAction={commitOrgImportAction} discardAction={discardOrgImportAction} /></PageLayout>
}
