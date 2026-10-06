"use client"

import { useEffect, useState } from "react"
import { discoverCatalogGroupCategoriesAction, discoverCatalogPackageMembersAction } from "@/app/(app)/design-studio/actions"
import { unwrapAction } from "@/lib/action-result"
import type { CatalogPackageMemberPage } from "@/lib/services/catalog-package-members"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"

type Member = CatalogPackageMemberPage["items"][number]
type DiscoveryScope = { expectedOrgId: string; expectedActorId: string; communityId: string | null }
const pageSize = 20

export function CatalogMemberPicker({ scope, selectedIds, disabled, onToggle, domain }: {
  scope: DiscoveryScope; domain: "package" | "group"; selectedIds: string[]; disabled: boolean; onToggle: (id: string, members?: Member[]) => void
}) {
  const group = domain === "group"
  const discover = group ? discoverCatalogGroupCategoriesAction : discoverCatalogPackageMembersAction
  const [query, setQuery] = useState("")
  const [search, setSearch] = useState("")
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  const [selectedOnly, setSelectedOnly] = useState(false)
  const [selectedPage, setSelectedPage] = useState(1)
  const [retry, setRetry] = useState(0)
  const { expectedOrgId, expectedActorId, communityId } = scope
  const cursor = cursors.at(-1) ?? null, selectedKey = selectedIds.join(",")
  const identity = JSON.stringify([domain, expectedOrgId, expectedActorId, communityId, search, cursor, selectedKey])
  const [result, setResult] = useState<{ identity: string; page: CatalogPackageMemberPage; members: Member[] } | null>(null)
  const [failure, setFailure] = useState<{ identity: string; message: string } | null>(null)
  useEffect(() => {
    if (query.trim().toLowerCase() === search) return
    const timer = setTimeout(() => { setSearch(query.trim().toLowerCase()); setCursors([null]); setSelectedPage(1) }, 250)
    return () => clearTimeout(timer)
  }, [query, search])
  useEffect(() => {
    let current = true
    setResult(null)
    setFailure(null)
    async function load() {
      try {
        const [page, selection] = await Promise.all([
          discover({ expectedOrgId, expectedActorId, communityId, query: search, cursor }),
          discover({ expectedOrgId, expectedActorId, communityId, selectedIds: selectedKey ? selectedKey.split(",") : [] }),
        ])
        const next = { identity, page: unwrapAction(page), members: unwrapAction(selection).items }
        if (current) setResult(next)
      } catch (error) {
        if (current) setFailure({ identity, message: error instanceof Error ? error.message : "Could not load catalog members" })
      }
    }
    void load()
    return () => { current = false }
  }, [identity, retry, discover, expectedOrgId, expectedActorId, communityId, search, cursor, selectedKey])
  const ready = result?.identity === identity && query.trim().toLowerCase() === search
  const selected = new Set(selectedIds.map(id => id.toLowerCase()))
  const members = ready ? result.members : []
  const selectedCategories = new Set(members.map(row => row.categoryKey))
  const needle = query.trim().toLowerCase()
  const selectedRows = members.filter(row => !needle || `${row.name ?? ""} ${row.categoryName ?? ""} ${row.id}`.toLowerCase().includes(needle))
  const pages = Math.max(1, Math.ceil(selectedRows.length / pageSize)), currentPage = Math.min(selectedPage, pages)
  const rows = ready ? selectedOnly ? selectedRows.slice((currentPage - 1) * pageSize, currentPage * pageSize) : result.page.items : []
  const metadata = ready ? [...result.page.items, ...members] : []
  const error = failure?.identity === identity ? failure.message : null
  return <section aria-label={group ? "Rule categories" : "Package members"} aria-busy={!ready && !error} className="col-span-2 space-y-3 border-t pt-3">
    <p className="text-xs text-muted-foreground">{selected.size} of 100 {group ? "category references" : "members"} selected. {group ? "Choosing another variant replaces its reference in this category. Unavailable original categories can be removed." : "Choosing another option in a category replaces its selected option. Unavailable original members can be removed."}</p>
    <div className="flex flex-wrap items-center gap-2">
      <Input aria-label={group ? "Search rule categories" : "Search package members"} placeholder={group ? "Search category or reference" : "Search option, category or reference"} value={query} maxLength={200} disabled={disabled} onChange={event => { if (!disabled) setQuery(event.target.value) }} />
      <Button type="button" size="sm" variant="outline" disabled={disabled} aria-pressed={selectedOnly} onClick={() => { if (!disabled) { setSelectedOnly(value => !value); setSelectedPage(1) } }}>{selectedOnly ? group ? "Show all categories" : "Show all options" : group ? "Review selected categories" : "Review selected members"}</Button>
    </div>
    {error ? <div role="alert" className="space-y-2 text-sm"><p>{error}</p><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { if (!disabled) { setResult(null); setRetry(value => value + 1) } }}>{group ? "Retry category discovery" : "Retry member discovery"}</Button></div> : !ready ? <div aria-label={group ? "Loading rule categories" : "Loading package members"} className="space-y-2">{Array.from({ length: 5 }, (_, index) => <div key={index} className="h-10 animate-pulse bg-muted" />)}</div> : <>
      <ul className="divide-y">{rows.map(row => {
        const checked = selected.has(row.id.toLowerCase()), canAdd = row.available && (selected.size < 100 || row.categoryKey !== null && selectedCategories.has(row.categoryKey))
        return <li key={row.id} className="py-2"><label className="flex items-start gap-2 text-sm"><Checkbox checked={checked} disabled={disabled || !checked && !canAdd} onCheckedChange={() => { if (!disabled && (checked || canAdd)) onToggle(row.id, metadata) }} /><span><span className="block">{row.name ?? (group ? "Category unavailable in this catalog" : "Member unavailable in this catalog")}{!row.available ? " · Unavailable" : ""}</span><span className="block text-xs text-muted-foreground">{row.categoryName ?? (group ? "Original category" : "Original member")} · <span className="font-mono">{row.id}</span></span></span></label></li>
      })}</ul>
      {rows.length === 0 && <p className="text-sm text-muted-foreground">No {group ? "categories" : "members"} match this view.</p>}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Page {selectedOnly ? currentPage : cursors.length} · {rows.length} {group ? "categories" : "members"} · 20 per page</span>
        <Button type="button" size="sm" variant="ghost" disabled={disabled || (selectedOnly ? currentPage === 1 : cursors.length === 1)} onClick={() => { if (disabled) return; if (selectedOnly) setSelectedPage(value => Math.max(1, value - 1)); else setCursors(value => value.slice(0, -1)) }}>{group ? "Previous categories" : "Previous members"}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled || (selectedOnly ? currentPage === pages : !result.page.nextCursor)} onClick={() => { if (disabled) return; if (selectedOnly) setSelectedPage(value => Math.min(pages, value + 1)); else if (result.page.nextCursor) setCursors(value => [...value, result.page.nextCursor]) }}>{group ? "Next categories" : "Next members"}</Button>
      </div>
    </>}
  </section>
}
