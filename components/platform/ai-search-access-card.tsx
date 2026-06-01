"use client"

import { useMemo, useState, useTransition } from "react"

import { setAiSearchAccessAction } from "@/app/(app)/platform/actions"
import { Sparkles } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

export interface OrgAiSearchAccess {
  orgId: string
  orgName: string
  enabled: boolean
}

interface AiSearchAccessCardProps {
  orgs: OrgAiSearchAccess[]
  canManage: boolean
}

export function AiSearchAccessCard({ orgs: initialOrgs, canManage }: AiSearchAccessCardProps) {
  const [orgs, setOrgs] = useState<OrgAiSearchAccess[]>(initialOrgs)
  const [filter, setFilter] = useState("")
  const [pendingOrgId, setPendingOrgId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const visibleOrgs = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return orgs
    return orgs.filter((org) => org.orgName.toLowerCase().includes(needle))
  }, [orgs, filter])

  const handleToggle = (orgId: string, nextEnabled: boolean) => {
    if (!canManage || pendingOrgId) return
    setError(null)
    setPendingOrgId(orgId)

    // Optimistic update; revert if the action fails.
    setOrgs((prev) => prev.map((org) => (org.orgId === orgId ? { ...org, enabled: nextEnabled } : org)))

    startTransition(async () => {
      const result = await setAiSearchAccessAction({ orgId, enabled: nextEnabled })
      if (result?.error) {
        setError(result.error)
        setOrgs((prev) => prev.map((org) => (org.orgId === orgId ? { ...org, enabled: !nextEnabled } : org)))
      }
      setPendingOrgId(null)
    })
  }

  return (
    <div className="rounded-xl border border-border/70 bg-background/80 p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-cyan-500" />
            <h3 className="text-base font-semibold">AI Search Access</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Turn the conversational AI search (the “Ask AI” command bar) on or off per organization. Record search is
            unaffected.
          </p>
        </div>
        <Badge variant="secondary" className="rounded-md">
          {orgs.filter((org) => org.enabled).length}/{orgs.length} enabled
        </Badge>
      </div>

      {orgs.length > 8 && (
        <div className="mt-4">
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter organizations..."
            className="h-9"
          />
        </div>
      )}

      <div className="mt-4 max-h-80 space-y-1.5 overflow-y-auto pr-1">
        {visibleOrgs.map((org) => (
          <div
            key={org.orgId}
            className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{org.orgName}</div>
              <div className="text-xs text-muted-foreground">{org.enabled ? "AI search enabled" : "AI search disabled"}</div>
            </div>
            <Switch
              checked={org.enabled}
              onCheckedChange={(checked) => handleToggle(org.orgId, checked)}
              disabled={!canManage || pendingOrgId === org.orgId}
            />
          </div>
        ))}

        {visibleOrgs.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No organizations match that filter.</p>
        )}
      </div>

      {!canManage && (
        <p className="mt-3 text-xs text-muted-foreground">Requires platform feature-flag management permissions.</p>
      )}

      {error && (
        <div className={cn("mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive")}>
          {error}
        </div>
      )}
    </div>
  )
}
