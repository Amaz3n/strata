"use client"

import { useEffect, useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { ActionResult } from "@/lib/action-result"

export type SearchPickerItem = { id: string; name: string; detail: string }
export type SearchPickerPage = { items: SearchPickerItem[]; nextCursor: string | null; nextPage: number | null }
export type SearchPickerQuery = { search: string; cursor?: string; page?: number }

/**
 * A picker that never holds the whole roster: every keystroke (debounced) and
 * every "Load more" asks the server for one scoped, bounded page.
 */
export function SearchPicker({ label, noun = label.toLowerCase(), placeholder = `Search ${noun} by name`, value, onChange, search: searchPage, disabled = false }: {
  label: string
  noun?: string
  /** What the search box says it matches, when that is more than the name. */
  placeholder?: string
  value: SearchPickerItem | null
  onChange: (value: SearchPickerItem | null) => void
  search: (query: SearchPickerQuery) => Promise<ActionResult<SearchPickerPage>>
  disabled?: boolean
}) {
  const [search, setSearch] = useState("")
  const [result, setResult] = useState<SearchPickerPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const searchId = useId()
  const request = useRef(0)
  const latestSearch = useRef(searchPage)
  latestSearch.current = searchPage

  useEffect(() => {
    const sequence = request
    const id = ++sequence.current
    if (value) return
    const timer = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await latestSearch.current({ search })
        if (request.current !== id) return
        if (!response.success) { setError(response.error); setResult(null); return }
        setResult(response.data)
      } catch {
        if (request.current === id) { setError("Unable to load results. Try searching again."); setResult(null) }
      } finally {
        if (request.current === id) setLoading(false)
      }
    }, 250)
    return () => { clearTimeout(timer); sequence.current++ }
  }, [search, value, retry])

  async function loadMore() {
    if (!result || loading) return
    const id = ++request.current
    setLoading(true)
    setError(null)
    try {
      const response = await latestSearch.current({ search, cursor: result.nextCursor ?? undefined, page: result.nextPage ?? 1 })
      if (id !== request.current) return
      if (!response.success) { setError(response.error); return }
      setResult({ ...response.data, items: [...new Map([...result.items, ...response.data.items].map((item) => [item.id, item])).values()] })
    } catch {
      if (id === request.current) setError("Unable to load more results. Try again.")
    } finally {
      if (id === request.current) setLoading(false)
    }
  }

  return <div className="space-y-2">
    <Label htmlFor={searchId}>{label}</Label>
    {value ? <div className="flex items-center justify-between gap-3 border p-3 text-sm">
      <div><p className="font-medium">{value.name}</p><p className="text-xs text-muted-foreground">{value.detail}</p></div>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => { setResult(null); onChange(null) }}>Change</Button>
    </div> : <>
      <Input id={searchId} value={search} disabled={disabled} placeholder={placeholder} onChange={(event) => { request.current++; setResult(null); setSearch(event.target.value) }} />
      <div className="max-h-52 overflow-y-auto border" aria-busy={loading}>
        {result?.items.map((item) => <button type="button" key={item.id} disabled={disabled || loading} className="flex w-full flex-col border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted focus-visible:outline focus-visible:outline-ring disabled:opacity-50" onClick={() => onChange(item)}>
          <span className="font-medium">{item.name}</span><span className="text-xs text-muted-foreground">{item.detail}</span>
        </button>)}
        {loading && <div role="status" aria-label="Loading results" className="space-y-2 p-3">{[0, 1, 2].map((row) => <div key={row} className="h-8 animate-pulse bg-muted" />)}</div>}
        {!loading && result?.items.length === 0 && <p className="p-3 text-sm text-muted-foreground">No matching results in your current scope.</p>}
      </div>
      {error && <div className="flex items-center justify-between gap-2"><p role="alert" className="text-sm text-destructive">{error}</p><Button type="button" variant="outline" size="sm" disabled={disabled || loading} onClick={() => { setResult(null); setRetry((value) => value + 1) }}>Retry</Button></div>}
      {(result?.nextCursor || result?.nextPage) && <Button type="button" variant="outline" size="sm" disabled={disabled || loading} onClick={loadMore}>Load more</Button>}
    </>}
  </div>
}
