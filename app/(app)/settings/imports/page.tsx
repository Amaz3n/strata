import Link from "next/link"

import { PageLayout } from "@/components/layout/page-layout"
import { SettingsGroup } from "@/components/settings/settings-section"
import { ChevronRight } from "@/components/icons"
import { getProjectPosture } from "@/lib/product-tier"
import { getOrgProductTier } from "@/lib/services/context"
import { IMPORTER_DEFINITIONS, IMPORTER_KEYS } from "@/lib/services/import-definitions"
import { listImportBatches, type ImportBatchSummary } from "@/lib/services/imports"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { orgHasPriceAgreements } from "@/lib/services/price-book"
import { orgHasProductionProjects } from "@/lib/services/production-desk-scope"

export const dynamic = "force-dynamic"

const CONTAINER = "mx-auto w-full max-w-3xl space-y-8 px-5 py-6 lg:px-8 lg:py-8"

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  staged: "Staged",
  validated: "Validated",
  committed: "Committed",
  failed: "Failed",
}

function batchSummary(batches: ImportBatchSummary[]) {
  const latest = batches[0]
  if (!latest) return "Never run"
  const status = STATUS_LABELS[latest.status] ?? latest.status
  return batches.length === 1 ? status : `${status} · ${batches.length} batches`
}

export default async function ImportsPage() {
  const [result, access, productTier, hasProductionProjects, hasPriceAgreements] = await Promise.all([
    listImportBatches({ limit: 50 }),
    getCurrentUserPermissions(),
    getOrgProductTier(),
    orgHasProductionProjects().catch(() => false),
    orgHasPriceAgreements().catch(() => false),
  ])

  const posture = getProjectPosture(null, productTier)
  const permissions = new Set(access.permissions)
  const hasAny = (...keys: string[]) => permissions.has("*") || keys.some((key) => permissions.has(key))
  // Mirrors the sidebar: an org running price agreements keeps Purchasing even
  // off the production tier, so its importer follows the same rule.
  const showsPurchasing = posture === "production" || hasProductionProjects || hasPriceAgreements

  const available = IMPORTER_KEYS.filter((key) => {
    const definition = IMPORTER_DEFINITIONS[key]
    // Open WIP cutover is run by us, not by the customer.
    if (key === "open_wip") return false
    if (key === "price_book") return showsPurchasing && hasAny("price_book.write", "commitment.write")
    if (definition.postures && !definition.postures.includes(posture)) return false
    if (key === "plan_library") return hasAny("plan.write")
    if (key === "option_catalog") return hasAny("selections.catalog.manage")
    if (key === "communities_lots") return hasAny("community.write", "lot.write")
    if (key === "team") return hasAny("members.manage")
    return true
  })

  return (
    <PageLayout
      fullBleed
      title="Data imports"
      breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Data imports" }]}
    >
      <div className={CONTAINER}>
        <SettingsGroup
          title="Importers"
          description="Bring existing data into Arc. Every import stages first — you validate and correct the rows before anything is committed."
        >
          {available.length === 0 ? (
            <div className="py-6">
              <p className="text-sm leading-5 text-foreground">No importers available</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Importing cost codes or your team roster needs the matching permission. Ask an organization admin.
              </p>
            </div>
          ) : (
            available.map((key) => {
              const definition = IMPORTER_DEFINITIONS[key]
              const batches = result.batches.filter((batch) => batch.importer === key)
              return (
                <Link
                  key={key}
                  href={`/settings/imports/${key}`}
                  className="group grid gap-2 py-4 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] sm:gap-8"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-5 text-foreground group-hover:underline">
                      {definition.label}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{definition.description}</p>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-sm leading-6 text-muted-foreground">
                      {batchSummary(batches)}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </div>
                </Link>
              )
            })
          )}
        </SettingsGroup>
      </div>
    </PageLayout>
  )
}
