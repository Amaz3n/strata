import { notFound } from "next/navigation"

import { ImportWorkspace } from "@/components/admin/import-workspace"
import { PageLayout } from "@/components/layout/page-layout"
import { IMPORTER_DEFINITIONS, IMPORTER_KEYS, type ImporterKey } from "@/lib/services/import-definitions"
import { getImportBatch, listImportBatches } from "@/lib/services/imports"
import { getOnboardingRun } from "@/lib/services/onboarding"
import { commitImportAction, discardImportAction, patchImportRowAction, previewImportAction, setImportUpdateExistingAction, stageImportAction } from "../../actions"

export const dynamic = "force-dynamic"

export default async function ImporterPage({ params, searchParams }: { params: Promise<{ orgId: string; importer: string }>; searchParams: Promise<{ batch?: string }> }) {
  const [{ orgId, importer: rawImporter }, query] = await Promise.all([params, searchParams])
  if (!IMPORTER_KEYS.includes(rawImporter as ImporterKey)) notFound()
  const importer = rawImporter as ImporterKey
  const definition = IMPORTER_DEFINITIONS[importer]
  const [onboarding, batchesResult] = await Promise.all([getOnboardingRun(orgId), listImportBatches({ importer, limit: 25 }, { platformOrgId: orgId })])
  if (!onboarding.run) notFound()
  const detail = query.batch ? await getImportBatch(query.batch, { limit: 500 }, { platformOrgId: orgId }) : null

  async function preview(input: { orgId?: string; importer: ImporterKey; csvText: string }) { "use server"; return previewImportAction({ orgId, importer: input.importer, csvText: input.csvText }) }
  async function stage(input: { orgId?: string; importer: ImporterKey; csvText: string; sourceFilename?: string; mapping: Record<string, string | null>; context?: Record<string, unknown>; onboardingRunId?: string | null }) { "use server"; return stageImportAction({ ...input, orgId }) }
  async function patch(input: { orgId?: string; importer: ImporterKey; batchId: string; rowId: string; patch?: Record<string, string | number | boolean | null>; skip?: boolean }) { "use server"; return patchImportRowAction({ ...input, orgId }) }
  async function updateExisting(input: { orgId?: string; importer: ImporterKey; batchId: string; updateExisting: boolean }) { "use server"; return setImportUpdateExistingAction({ ...input, orgId }) }
  async function commit(input: { orgId?: string; importer: ImporterKey; batchId: string }) { "use server"; return commitImportAction({ ...input, orgId }) }
  async function discard(input: { orgId?: string; importer: ImporterKey; batchId: string }) { "use server"; return discardImportAction({ ...input, orgId }) }

  return <PageLayout title={definition.label} breadcrumbs={[{ label: "Admin", href: "/admin" }, { label: "Customers", href: "/admin/customers" }, { label: onboarding.org.name, href: `/admin/customers/${orgId}/onboarding` }, { label: definition.label }]}><ImportWorkspace orgId={orgId} onboardingRunId={onboarding.run.id} importer={importer} label={definition.label} description={definition.description} columns={definition.columns} fileKinds={definition.fileKinds} batches={batchesResult.batches} detail={detail} backHref={`/admin/customers/${orgId}/onboarding`} previewAction={preview} stageAction={stage} patchAction={patch} updateExistingAction={updateExisting} commitAction={commit} discardAction={discard} /></PageLayout>
}
