import Link from "next/link"

import { PageLayout } from "@/components/layout/page-layout"
import { Badge } from "@/components/ui/badge"
import { IMPORTER_DEFINITIONS, IMPORTER_KEYS } from "@/lib/services/import-definitions"
import { listImportBatches } from "@/lib/services/imports"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export const dynamic = "force-dynamic"

export default async function ImportsPage() {
  const [result, access] = await Promise.all([listImportBatches({ limit: 50 }), getCurrentUserPermissions()])
  const permissions = new Set(access.permissions)
  const hasAny = (...keys: string[]) => permissions.has("*") || keys.some((key) => permissions.has(key))
  const available = IMPORTER_KEYS.filter((key) => {
    if (key === "open_wip") return false
    if (key === "plan_library") return hasAny("plan.write")
    if (key === "option_catalog") return hasAny("selections.catalog.manage")
    if (key === "price_book") return hasAny("price_book.write", "commitment.write")
    if (key === "communities_lots") return hasAny("community.write", "lot.write")
    if (key === "team") return hasAny("members.manage")
    return true
  })
  return <PageLayout title="Data imports" breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Data imports" }]}><div className="space-y-5"><div className="border-b pb-4"><h1 className="text-xl font-semibold tracking-tight">Data imports</h1><p className="mt-1 text-sm text-muted-foreground">Stage, validate, correct, and commit organization data. Open-WIP cutover remains platform-assisted.</p></div><div className="divide-y border">{available.map((key) => { const definition = IMPORTER_DEFINITIONS[key]; const batches = result.batches.filter((batch) => batch.importer === key); const latest = batches[0]; return <Link key={key} href={`/settings/imports/${key}`} className="grid grid-cols-[minmax(0,1fr)_100px_100px] items-center gap-3 px-4 py-3 hover:bg-muted/30"><span><span className="block text-sm font-medium">{definition.label}</span><span className="block truncate text-xs text-muted-foreground">{definition.description}</span></span><Badge variant="outline">{batches.length} batches</Badge><span className="text-right text-xs text-muted-foreground">{latest?.status ?? "Not started"}</span></Link> })}</div></div></PageLayout>
}
