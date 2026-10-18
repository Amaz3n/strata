import "server-only"
import type { ImporterKey } from "@/lib/services/import-definitions"
import { commitAgreementRows, validateAgreementRows } from "@/lib/services/cutover/agreements"
import { commitInspectionHistoryRows, validateInspectionHistoryRows } from "@/lib/services/cutover/inspection-history"
import { commitSelectionRows, validateSelectionRows } from "@/lib/services/cutover/selections"
import type { CutoverImportContext, CutoverStagedRow } from "@/lib/services/cutover/homes"

/**
 * Importers a member runs with their own domain's permission instead of the
 * broad import.manage: the people who own the records bring them over.
 */
export const NARROW_IMPORTER_PERMISSIONS: Partial<Record<ImporterKey, string>> = {
  warranty_homes: "warranty.manage",
  agreements: "closing.manage",
  selections: "design_studio.manage",
  inspection_history: "inspection.write",
}

const CUTOVER_IMPORTERS = ["agreements", "selections", "inspection_history"] as const
type CutoverImporter = (typeof CUTOVER_IMPORTERS)[number]

export function isCutoverImporter(importer: ImporterKey): importer is CutoverImporter {
  return (CUTOVER_IMPORTERS as readonly string[]).includes(importer)
}

export function validateCutoverRows<Row extends CutoverStagedRow>(importer: CutoverImporter, rows: Row[], context: CutoverImportContext, batchContext: Record<string, unknown>) {
  if (importer === "agreements") return validateAgreementRows(rows, context)
  if (importer === "selections") return validateSelectionRows(rows, context, batchContext)
  return validateInspectionHistoryRows(rows, context)
}

export function commitCutoverRows(importer: CutoverImporter, rows: CutoverStagedRow[], context: CutoverImportContext, batchId: string, batchContext: Record<string, unknown>) {
  if (importer === "agreements") return commitAgreementRows(rows, context, batchId)
  if (importer === "selections") return commitSelectionRows(rows, context, batchId, batchContext)
  return commitInspectionHistoryRows(rows, context, batchId)
}
