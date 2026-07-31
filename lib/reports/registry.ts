import type { ProjectPosture } from "@/lib/product-tier"
import { FINANCIAL_REPORTS } from "@/lib/reports/definitions/financial"
import { PRODUCTION_REPORTS } from "@/lib/reports/definitions/production"
import { PARITY_REPORTS } from "@/lib/reports/definitions/parity"
import {
  REPORT_GROUP_LABELS,
  type ReportAvailabilityContext,
  type ReportDefinition,
  type ReportFormat,
  type ReportGroup,
  type ReportScope,
} from "@/lib/reports/types"

/**
 * The catalog. A report exists when it appears here and nowhere else — the
 * catalog page, the viewer, the export route, and run history all read from
 * this list, so a report can never ship invisible or unexportable.
 */
export const REPORT_DEFINITIONS: ReportDefinition[] = [...FINANCIAL_REPORTS, ...PRODUCTION_REPORTS, ...PARITY_REPORTS]

/**
 * Group order on the catalog, by posture. A production builder lives in the
 * production and sales line and reaches for financials second; everyone else
 * leads with money. Ordering only — availability is decided per report.
 */
export function reportGroupOrder(posture: ProjectPosture): ReportGroup[] {
  return posture === "production"
    ? ["production", "sales", "financial", "compliance"]
    : ["financial", "production", "sales", "compliance"]
}

/** The catalog-row summary in this posture's vocabulary. */
export function reportSummary(definition: ReportDefinition, posture: ProjectPosture): string {
  return definition.summaryByPosture?.[posture] ?? definition.summary
}

const BY_SLUG = new Map(REPORT_DEFINITIONS.map((definition) => [definition.slug, definition]))

export function getReportDefinition(slug: string): ReportDefinition | undefined {
  return BY_SLUG.get(slug)
}

export function reportFormats(definition: ReportDefinition): ReportFormat[] {
  return definition.formats ?? ["csv", "pdf"]
}

export function supportsFormat(definition: ReportDefinition, format: string): format is ReportFormat {
  return format === "json" || reportFormats(definition).includes(format as ReportFormat)
}

interface CatalogFilter extends ReportAvailabilityContext {
  /** Flat permission list for the signed-in membership; "*" means platform. */
  permissions: string[]
}

function permitted(definition: ReportDefinition, permissions: string[]) {
  if (permissions.includes("*")) return true
  return definition.permissions.some((key) => permissions.includes(key))
}

/**
 * Everything the caller may actually run at this scope. Reports the membership
 * cannot open never render — an unreachable catalog row is just a tease.
 */
export function listReports(filter: CatalogFilter): ReportDefinition[] {
  return REPORT_DEFINITIONS.filter((definition) => {
    if (!definition.scopes.includes(filter.scope)) return false
    if (!permitted(definition, filter.permissions)) return false
    if (definition.available && !definition.available(filter)) return false
    return true
  })
}

export interface ReportCatalogGroup {
  group: ReportGroup
  label: string
  reports: ReportDefinition[]
}

export function groupReports(definitions: ReportDefinition[], posture: ProjectPosture): ReportCatalogGroup[] {
  return reportGroupOrder(posture)
    .map((group) => ({
      group,
      label: REPORT_GROUP_LABELS[group],
      reports: definitions.filter((definition) => definition.group === group),
    }))
    .filter((entry) => entry.reports.length > 0)
}

/** Base path for a report at a given scope — the one place routes are spelled. */
export function reportHref(scope: ReportScope, slug: string, projectId?: string) {
  return scope === "project" && projectId ? `/projects/${projectId}/reports/${slug}` : `/reports/${slug}`
}

export function reportCatalogHref(scope: ReportScope, projectId?: string) {
  return scope === "project" && projectId ? `/projects/${projectId}/reports` : "/reports"
}
