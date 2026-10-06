"use client"

import { useState } from "react"
import type { CatalogPublicationReference } from "@/lib/services/catalog-publication-reconciliation"
import type { CatalogPublicationLabels } from "@/lib/validation/catalog-publication-review"
import { Button } from "@/components/ui/button"

const pageSize = 20
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
function money(cents: number | null | undefined) { return cents == null ? "No cost" : currency.format(cents / 100) }
function costChange(before: number | null | undefined, after: number | null | undefined) {
  return after === undefined ? "Unchanged" : `${before === undefined ? "Not recorded" : money(before)} → ${after === null ? "Clear cost" : money(after)}`
}

export function CatalogPublicationReview({ publication, labels, canReadMargin, disabled }: {
  publication: CatalogPublicationReference; labels: CatalogPublicationLabels | null; canReadMargin: boolean; disabled: boolean
}) {
  const [page, setPage] = useState(1)
  const count = publication.kind === "prices" ? publication.attempt.items.length : publication.kind === "group" ? publication.attempt.expectedCategoryVersions.length : publication.attempt.optionIds.length
  const pages = Math.max(1, Math.ceil(count / pageSize)), current = Math.min(page, pages), start = (current - 1) * pageSize
  const pagination = <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
    <span>{count === 0 ? "No category assignments" : `Showing ${start + 1}–${Math.min(start + pageSize, count)} of ${count}`}</span>
    <Button type="button" size="sm" variant="ghost" disabled={disabled || current === 1} onClick={() => { if (!disabled) setPage(value => Math.max(1, value - 1)) }}>Previous reviewed items</Button>
    <Button type="button" size="sm" variant="ghost" disabled={disabled || current === pages} onClick={() => { if (!disabled) setPage(value => Math.min(pages, value + 1)) }}>Next reviewed items</Button>
  </div>
  return <section aria-label="Original publication review" className="space-y-3">
    <div className="space-y-1">
      <p className="font-medium">Original reviewed {publication.kind === "prices" ? "price batch" : publication.kind === "group" ? "cutoff rule save" : "package save"}</p>
      <p className="text-xs text-muted-foreground">Values below come from the saved request. {labels ? "Names were captured when it was registered." : "Captured names are unavailable; references identify the original subjects."} They do not describe the current catalog.</p>
    </div>
    {publication.kind === "group" ? <>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-muted-foreground">Rule</dt><dd>{publication.attempt.expectedGroup ? `${publication.attempt.expectedGroup.name} → ` : "New rule · "}{publication.attempt.name}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Schedule task</dt><dd>{publication.attempt.expectedGroup ? `${publication.attempt.expectedGroup.schedule_task_key} → ` : ""}{publication.attempt.scheduleTaskKey}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Cutoff</dt><dd>{publication.attempt.expectedGroup ? `${publication.attempt.expectedGroup.cutoff_offset_days} days from ${publication.attempt.expectedGroup.cutoff_anchor} → ` : ""}{publication.attempt.cutoffOffsetDays} days from {publication.attempt.cutoffAnchor}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Original scope</dt><dd className="font-mono text-xs">{publication.attempt.communityId ?? "Organization rules"}</dd></div>
      </dl>
      <p className="text-xs text-muted-foreground">Requested assignments · {publication.attempt.categoryIds.length} categories{publication.attempt.expectedGroup ? ` · previously ${publication.attempt.expectedGroup.category_ids.length}` : ""}. Reviewed override roots appear below with their definitions.</p>
      <ul className="divide-y text-sm">{publication.attempt.expectedCategoryVersions.slice(start, start + pageSize).map(version => {
        const captured = labels?.kind === "group" ? labels.categories.find(row => row.id === version.id) : null
        const definition = captured?.definition
        return <li key={version.id} className="space-y-1 py-2">
          <p className="font-medium">{definition?.name ?? "Category name unavailable"} <span className="text-xs font-normal text-muted-foreground">{publication.attempt.categoryIds.some(id => id.toLowerCase() === version.id) ? "Requested assignment" : "Override root"}</span></p>
          <p className="font-mono text-xs text-muted-foreground">{version.id}</p>
          {definition && <>
            {definition.description && <p className="whitespace-pre-wrap">{definition.description}</p>}
            <p className="text-xs text-muted-foreground">{definition.community_id ? `Community ${definition.community_id}` : "Organization category"} · order {definition.sort_order ?? "unspecified"} · {definition.is_archived ? "archived" : "active"}</p>
            {definition.parent_category_id && <p className="font-mono text-xs text-muted-foreground">Root {definition.parent_category_id}</p>}
            {definition.image_url && <p className="break-all text-xs text-muted-foreground">Image {definition.image_url}</p>}
          </>}
        </li>
      })}</ul>
    </> : publication.kind === "package" ? <>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-muted-foreground">Package</dt><dd className="font-medium">{publication.attempt.name}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Price</dt><dd className="tabular-nums">{publication.attempt.expectedPackage ? `${currency.format(publication.attempt.expectedPackage.price_cents / 100)} → ` : "New package · "}{currency.format(publication.attempt.priceCents / 100)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Availability</dt><dd>{publication.attempt.expectedPackage ? `${publication.attempt.expectedPackage.is_available ? "Available" : "Unavailable"} → ` : ""}{publication.attempt.isAvailable ? "Available" : "Unavailable"}</dd></div>
        {(publication.attempt.isArchived !== undefined || publication.attempt.editArchived) && <div><dt className="text-xs text-muted-foreground">Catalog status</dt><dd>{publication.attempt.expectedPackage?.is_archived ? "Archived" : "Active"} → {publication.attempt.isArchived ?? publication.attempt.expectedPackage?.is_archived ? "Archived" : "Active"}</dd></div>}
        {canReadMargin && <div><dt className="text-xs text-muted-foreground">Cost</dt><dd className="tabular-nums">{costChange(publication.attempt.expectedPackage?.cost_cents, publication.attempt.costCents)}</dd></div>}
      </dl>
      {publication.attempt.description && <p className="whitespace-pre-wrap text-sm">{publication.attempt.description}</p>}
      <p className="text-xs text-muted-foreground">Requested members · {count} options{publication.attempt.expectedPackage ? ` · previously ${publication.attempt.expectedPackage.option_ids.length}` : ""}</p>
      <ul className="space-y-1 text-sm">{publication.attempt.optionIds.slice(start, start + pageSize).map(optionId => {
        const captured = labels?.kind === "package" ? labels.options.find(row => row.optionId.toLowerCase() === optionId.toLowerCase()) : null
        return <li key={optionId}><span>{captured?.name ?? "Option name unavailable"}</span><span className="ml-2 font-mono text-xs text-muted-foreground">{optionId}</span></li>
      })}</ul>
    </> : <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Original requested price and availability changes</caption>
        <thead><tr className="border-b text-xs text-muted-foreground"><th className="py-2 pr-4 font-medium">Subject</th><th className="py-2 pr-4 font-medium">Plan version</th><th className="py-2 pr-4 text-right font-medium">Price</th><th className="py-2 pr-4 font-medium">Availability</th>{canReadMargin && <th className="py-2 text-right font-medium">Cost</th>}</tr></thead>
        <tbody>{publication.attempt.items.slice(start, start + pageSize).map(item => {
          const captured = labels?.kind === "prices" ? labels.items.find(row => row.optionId?.toLowerCase() === item.optionId?.toLowerCase() && row.packageId?.toLowerCase() === item.packageId?.toLowerCase() && row.housePlanVersionId.toLowerCase() === item.housePlanVersionId.toLowerCase()) : null
          return <tr key={`${item.optionId ?? item.packageId}:${item.housePlanVersionId}`} className="border-b align-top">
            <td className="py-2 pr-4"><p>{captured?.subjectName ?? (item.optionId ? "Option name unavailable" : "Package name unavailable")}</p><p className="font-mono text-xs text-muted-foreground">{item.optionId ?? item.packageId}</p></td>
            <td className="py-2 pr-4"><p>{captured?.planName ?? "Plan name unavailable"}{captured?.versionLabel ? ` · ${captured.versionLabel}` : ""}</p><p className="font-mono text-xs text-muted-foreground">{item.housePlanVersionId}</p></td>
            <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums">{item.expectedPrice ? currency.format(item.expectedPrice.price_cents / 100) : "Inherited / no scoped price"} → {currency.format(item.priceCents / 100)}</td>
            <td className="py-2 pr-4">{item.expectedPrice ? `${item.expectedPrice.is_available ? "Available" : "Unavailable"} → ` : ""}{item.isAvailable ? "Available" : "Unavailable"}</td>
            {canReadMargin && <td className="whitespace-nowrap py-2 text-right tabular-nums">{costChange(item.expectedPrice?.cost_cents, item.costCents)}</td>}
          </tr>
        })}</tbody>
      </table>
    </div>}
    {pagination}
    {publication.kind !== "group" && !canReadMargin && <p className="text-xs text-muted-foreground">Costs are hidden until current margin access is confirmed.</p>}
  </section>
}
