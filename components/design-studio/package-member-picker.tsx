"use client"

import { useMemo, useState } from "react"
import type { CatalogCategoryDto } from "@/lib/services/option-catalog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"

import { CatalogMemberPicker } from "@/components/design-studio/catalog-member-picker"
import type { CatalogPackageMemberPage } from "@/lib/services/catalog-package-members"

type Member = CatalogPackageMemberPage["items"][number]
type DiscoveryScope = { expectedOrgId: string; expectedActorId: string; communityId: string | null }
const pageSize = 20
export function PackageMemberPicker({ categories, selectedIds, disabled, onToggle, discoveryScope }: {
  categories: CatalogCategoryDto[]; selectedIds: string[]; disabled: boolean; onToggle: (id: string, members?: Member[]) => void; discoveryScope?: DiscoveryScope
}) {
  if (discoveryScope) return <CatalogMemberPicker domain="package" scope={discoveryScope} selectedIds={selectedIds} disabled={disabled} onToggle={onToggle} />
  return <LoadedPackageMembers categories={categories} selectedIds={selectedIds} disabled={disabled} onToggle={onToggle} />
}

function LoadedPackageMembers({ categories, selectedIds, disabled, onToggle }: {
  categories: CatalogCategoryDto[]; selectedIds: string[]; disabled: boolean; onToggle: (id: string) => void
}) {
  const [query, setQuery] = useState("")
  const [selectedOnly, setSelectedOnly] = useState(false)
  const [page, setPage] = useState(1)
  const selected = useMemo(() => new Set(selectedIds.map(id => id.toLowerCase())), [selectedIds])
  const catalogRows = useMemo(() => categories.flatMap(category => category.options.map(option => ({ id: option.id, name: option.name, category: category.name, categoryId: category.parent_category_id ?? category.id, available: option.is_available !== false && !option.is_archived && !category.is_archived }))), [categories])
  const rows = useMemo(() => {
    const known = new Set(catalogRows.map(row => row.id.toLowerCase()))
    const missing = selectedIds.filter(id => !known.has(id.toLowerCase())).map(id => ({ id, name: "Member unavailable in this catalog", category: "Original member", categoryId: null, available: false }))
    const needle = query.trim().toLowerCase()
    return [...missing, ...catalogRows].filter(row => (!selectedOnly || selected.has(row.id.toLowerCase())) && (!needle || `${row.name} ${row.category} ${row.id}`.toLowerCase().includes(needle)))
  }, [catalogRows, selectedIds, selectedOnly, selected, query])
  const pages = Math.max(1, Math.ceil(rows.length / pageSize)), current = Math.min(page, pages), start = (current - 1) * pageSize
  const selectedCategories = new Set(catalogRows.filter(row => selected.has(row.id.toLowerCase())).map(row => row.categoryId))
  return <section aria-label="Package members" className="col-span-2 space-y-3 border-t pt-3">
    <p className="text-xs text-muted-foreground">{selected.size} of 100 members selected. Choosing another option in a category replaces its selected option. Unavailable original members can be removed.</p>
    <div className="flex flex-wrap items-center gap-2">
      <Input aria-label="Search package members" placeholder="Search option, category or reference" value={query} maxLength={200} disabled={disabled} onChange={event => { if (!disabled) { setQuery(event.target.value); setPage(1) } }} />
      <Button type="button" size="sm" variant="outline" aria-pressed={selectedOnly} disabled={disabled} onClick={() => { if (!disabled) { setSelectedOnly(value => !value); setPage(1) } }}>{selectedOnly ? "Show all options" : "Review selected members"}</Button>
    </div>
    <ul className="divide-y">{rows.slice(start, start + pageSize).map(row => {
      const checked = selected.has(row.id.toLowerCase()), canAdd = row.available && (selected.size < 100 || row.categoryId !== null && selectedCategories.has(row.categoryId))
      return <li key={row.id} className="py-2"><label className="flex items-start gap-2 text-sm"><Checkbox checked={checked} disabled={disabled || !checked && !canAdd} onCheckedChange={() => { if (!disabled && (checked || canAdd)) onToggle(row.id) }} /><span><span className="block">{row.name}{!row.available ? " · Unavailable" : ""}</span><span className="block text-xs text-muted-foreground">{row.category} · <span className="font-mono">{row.id}</span></span></span></label></li>
    })}</ul>
    {rows.length === 0 && <p className="text-sm text-muted-foreground">No members match this view.</p>}
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{rows.length ? `Showing ${start + 1}–${Math.min(start + pageSize, rows.length)} of ${rows.length}` : "0 matching members"} · 20 per page</span>
      <Button type="button" size="sm" variant="ghost" disabled={disabled || current === 1} onClick={() => { if (!disabled) setPage(value => Math.max(1, value - 1)) }}>Previous members</Button>
      <Button type="button" size="sm" variant="ghost" disabled={disabled || current === pages} onClick={() => { if (!disabled) setPage(value => Math.min(pages, value + 1)) }}>Next members</Button>
    </div>
  </section>
}
