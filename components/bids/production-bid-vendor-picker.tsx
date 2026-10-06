"use client"

import { useEffect, useState } from "react"
import { searchProductionBidVendorsAction } from "@/app/(app)/bids/actions"
import type { BidVendorChoice } from "@/lib/services/production-bid-vendors"
import { unwrapAction } from "@/lib/action-result"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"

export function ProductionBidVendorPicker({ packageId, value, onChange, excludedIds = [], single = false, disabled = false }: {
  packageId: string
  value: BidVendorChoice[]
  onChange: (value: BidVendorChoice[]) => void
  excludedIds?: string[]
  single?: boolean
  disabled?: boolean
}) {
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<BidVendorChoice[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    const timer = setTimeout(async () => {
      try {
        const result = unwrapAction(await searchProductionBidVendorsAction({ packageId, search, page }))
        if (active) { setItems(result.items); setMore(result.more) }
      } catch (cause) {
        if (active) { setItems([]); setMore(false); setError(cause instanceof Error ? cause.message : "Unable to search vendors") }
      } finally { if (active) setLoading(false) }
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [packageId, search, page, retry])
  const selected = new Set(value.map((item) => item.id))
  const excluded = new Set(excludedIds)
  return <div className="space-y-2">
    <Input aria-label="Search vendors by name or trade" placeholder="Search vendors by name or trade" value={search} disabled={disabled}
      onChange={(event) => { setSearch(event.target.value); setPage(1) }} />
    {value.length > 0 && <div className="flex flex-wrap gap-1" aria-label="Selected vendors">
      {value.map((item) => <Button type="button" key={item.id} size="sm" variant="secondary" disabled={disabled}
        aria-label={`Remove ${item.name}`} onClick={() => onChange(value.filter((entry) => entry.id !== item.id))}>{item.name} ×</Button>)}
    </div>}
    <div className="max-h-56 overflow-auto border" aria-busy={loading}>
      {loading ? <p role="status" className="p-3 text-sm text-muted-foreground">Loading vendors…</p>
        : error ? <div role="alert" className="p-3 text-sm">{error}<Button type="button" variant="link" onClick={() => setRetry((value) => value + 1)}>Retry</Button></div>
        : items.length === 0 ? <p className="p-3 text-sm text-muted-foreground">No vendors match.</p>
        : items.map((item) => <label key={item.id} className="flex items-center gap-2 border-b p-2 text-sm last:border-b-0">
          <Checkbox checked={selected.has(item.id)} disabled={disabled || excluded.has(item.id)} onCheckedChange={(checked) => {
            onChange(checked === true ? single ? [item] : [...value.filter((entry) => entry.id !== item.id), item] : value.filter((entry) => entry.id !== item.id))
          }} />
          <span className="flex-1">{item.name}<span className="ml-2 text-xs text-muted-foreground">{item.detail}</span></span>
          {excluded.has(item.id) && <span className="text-xs text-muted-foreground">Invited</span>}
        </label>)}
    </div>
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <span>Page {page} · {value.length} selected</span>
      <div className="flex gap-1">
        <Button type="button" variant="outline" size="sm" disabled={disabled || loading || page === 1} onClick={() => setPage(page - 1)}>Previous</Button>
        <Button type="button" variant="outline" size="sm" disabled={disabled || loading || !more} onClick={() => setPage(page + 1)}>Next</Button>
      </div>
    </div>
  </div>
}
