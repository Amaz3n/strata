"use client"

import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import { setAiSearchAccessAction } from "@/app/(app)/platform/actions"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Search } from "@/components/icons"
import { cn } from "@/lib/utils"
import { unwrapAction } from "@/lib/action-result"
import type { OrgAiSearchAccess } from "@/lib/services/ai-search-access"

/**
 * Which orgs get AI search and the assistant. Local state is the source of truth
 * for the switch so a toggle lands instantly; a failure puts it straight back.
 */

type Filter = "all" | "on" | "off"

export function AiOrgAccess({ orgs, canManage }: { orgs: OrgAiSearchAccess[]; canManage: boolean }) {
  const [rows, setRows] = useState(orgs)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [pendingOrgId, setPendingOrgId] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const enabledCount = rows.filter((row) => row.enabled).length

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return rows.filter((row) => {
      if (filter === "on" && !row.enabled) return false
      if (filter === "off" && row.enabled) return false
      return !needle || row.orgName.toLowerCase().includes(needle)
    })
  }, [rows, query, filter])

  function toggle(orgId: string, enabled: boolean) {
    if (!canManage || pendingOrgId) return
    setPendingOrgId(orgId)
    setRows((prev) => prev.map((row) => (row.orgId === orgId ? { ...row, enabled } : row)))
    startTransition(async () => {
      try {
        unwrapAction(await setAiSearchAccessAction({ orgId, enabled }))
      } catch (cause) {
        setRows((prev) => prev.map((row) => (row.orgId === orgId ? { ...row, enabled: !enabled } : row)))
        toast.error(cause instanceof Error ? cause.message : "Could not update access.")
      } finally {
        setPendingOrgId(null)
      }
    })
  }

  if (rows.length === 0) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm font-medium">No organizations yet</p>
        <p className="mt-1 text-xs text-muted-foreground">Provision one from Platform to grant AI access.</p>
      </div>
    )
  }

  const FILTERS: Array<{ value: Filter; label: string; count: number }> = [
    { value: "all", label: "All", count: rows.length },
    { value: "on", label: "Enabled", count: enabledCount },
    { value: "off", label: "Disabled", count: rows.length - enabledCount },
  ]

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <h2 className="text-sm font-medium">Organization access</h2>
          <p className="text-xs text-muted-foreground">
            The master switch for AI search and the assistant. Orgs default to on until turned off here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter organizations"
              className="h-8 w-52 rounded-none pl-7 text-xs"
            />
          </div>
          <div className="flex items-center gap-px bg-border">
            {FILTERS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                onClick={() => setFilter(entry.value)}
                className={cn(
                  "px-2.5 py-1.5 text-xs transition-colors",
                  filter === entry.value
                    ? "bg-foreground text-background"
                    : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {entry.label}
                <span className="ml-1 tabular-nums opacity-70">{entry.count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="border-y py-12 text-center">
          <p className="text-sm font-medium">No organizations match</p>
          <p className="mt-1 text-xs text-muted-foreground">Clear the search, or switch back to All.</p>
        </div>
      ) : (
        <div className="divide-y border-y">
          {visible.map((row) => (
            <div key={row.orgId} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <Label htmlFor={`ai-access-${row.orgId}`} className="min-w-0 truncate text-sm font-normal">
                {row.orgName}
              </Label>
              <Switch
                id={`ai-access-${row.orgId}`}
                checked={row.enabled}
                disabled={!canManage || pendingOrgId === row.orgId}
                onCheckedChange={(checked) => toggle(row.orgId, checked)}
              />
            </div>
          ))}
        </div>
      )}

      <p className="px-4 py-3 text-[11px] text-muted-foreground">
        {enabledCount} of {rows.length} organizations have AI enabled.
        {!canManage ? " Read only — requires platform feature-flag permissions." : ""}
      </p>
    </div>
  )
}
