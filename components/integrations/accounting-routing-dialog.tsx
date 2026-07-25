"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"

import {
  listAccountingDimensionValuesAction,
  upsertAccountingEntityMapAction,
  type AccountingConnectionWithCapabilities,
  type AccountingRoute,
} from "@/app/(app)/settings/integrations/actions"
import { unwrapAction } from "@/lib/action-result"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DIMENSION_LABELS } from "@/lib/integrations/accounting/catalog"
import type { AccountingDimensionKind, AccountingDimensionValue } from "@/lib/integrations/accounting/provider"

type RouteScope = "org_default" | "division" | "community"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Route being edited, or null to create a new one. */
  route: AccountingRoute | null
  connections: AccountingConnectionWithCapabilities[]
  scopes: { divisions: { id: string; name: string }[]; communities: { id: string; name: string }[] }
  onSaved: () => void
}

const RESYNC_MARKER = "without acknowledgement"

export function AccountingRoutingDialog({ open, onOpenChange, route, connections, scopes, onSaved }: Props) {
  const activeConnections = connections.filter((row) => row.status === "active")
  const [scope, setScope] = useState<RouteScope>("org_default")
  const [scopeId, setScopeId] = useState("")
  const [connectionId, setConnectionId] = useState("")
  const [dimensionIds, setDimensionIds] = useState<Partial<Record<AccountingDimensionKind, string>>>({})
  const [dimensions, setDimensions] = useState<Partial<Record<AccountingDimensionKind, AccountingDimensionValue[]>>>({})
  const [loadingDimensions, setLoadingDimensions] = useState(false)
  const [saving, setSaving] = useState(false)
  const [resyncPrompt, setResyncPrompt] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (route) {
      const values = route.dimensions ?? {}
      setScope(route.scope === "division" || route.scope === "community" ? route.scope : "org_default")
      setScopeId(route.division_id ?? route.community_id ?? "")
      setConnectionId(route.connection_id)
      setDimensionIds(Object.fromEntries(Object.entries(values).map(([kind, value]) => [kind, value?.id ?? ""])))
    } else {
      setScope("org_default")
      setScopeId("")
      setConnectionId(activeConnections[0]?.id ?? "")
      setDimensionIds({})
    }
    setResyncPrompt(null)
    // activeConnections is derived from props and only seeds the default selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, route])

  const selected = connections.find((row) => row.id === connectionId)
  const dimensionKinds = selected?.capabilities.dimensions ?? []

  useEffect(() => {
    if (!open || !connectionId || dimensionKinds.length === 0) {
      setDimensions({})
      return
    }
    let active = true
    setLoadingDimensions(true)
    Promise.all(
      dimensionKinds.map(async (kind) => {
        const result = await listAccountingDimensionValuesAction(connectionId, kind)
        return [kind, result.success ? result.data : []] as const
      }),
    )
      .then((entries) => {
        if (active) setDimensions(Object.fromEntries(entries))
      })
      .finally(() => {
        if (active) setLoadingDimensions(false)
      })
    return () => {
      active = false
    }
    // dimensionKinds is stable for a given connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connectionId])

  const scopeOptions = scope === "division" ? scopes.divisions : scopes.communities
  const needsScopeId = scope === "division" || scope === "community"
  const canSave = Boolean(connectionId) && (!needsScopeId || Boolean(scopeId))

  const buildInput = (acknowledgeResync: boolean) => ({
    id: route?.id,
    connectionId,
    divisionId: scope === "division" ? scopeId : null,
    communityId: scope === "community" ? scopeId : null,
    dimensions: Object.fromEntries(
      Object.entries(dimensionIds).flatMap(([kind, id]) => {
        const value = dimensions[kind as AccountingDimensionKind]?.find((row) => row.id === id)
        return value ? [[kind, value]] : []
      }),
    ),
    acknowledgeResync,
  })

  const save = async (acknowledgeResync: boolean) => {
    setSaving(true)
    try {
      unwrapAction(await upsertAccountingEntityMapAction(buildInput(acknowledgeResync)))
      toast.success("Routing rule saved")
      setResyncPrompt(null)
      onOpenChange(false)
      onSaved()
    } catch (error) {
      const message = error instanceof Error ? error.message : "Try again."
      if (!acknowledgeResync && message.includes(RESYNC_MARKER)) {
        setResyncPrompt(message)
        return
      }
      toast.error("Unable to save routing rule", { description: message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{route ? "Edit routing rule" : "Add routing rule"}</DialogTitle>
            <DialogDescription>
              Choose which accounting file a set of projects posts to. A project rule beats a community rule, which beats a division
              rule, which beats the organization default.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-normal text-muted-foreground">Applies to</Label>
              <Select
                value={scope}
                onValueChange={(value) => {
                  setScope(value as RouteScope)
                  setScopeId("")
                }}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="org_default">Every unmapped project</SelectItem>
                  {scopes.divisions.length ? <SelectItem value="division">One division</SelectItem> : null}
                  {scopes.communities.length ? <SelectItem value="community">One community</SelectItem> : null}
                </SelectContent>
              </Select>
            </div>

            {needsScopeId ? (
              <div className="space-y-1.5">
                <Label className="text-xs font-normal text-muted-foreground">{scope === "division" ? "Division" : "Community"}</Label>
                <Select value={scopeId} onValueChange={setScopeId}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder={`Choose a ${scope}`} />
                  </SelectTrigger>
                  <SelectContent>
                    {scopeOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label className="text-xs font-normal text-muted-foreground">Posts to</Label>
              <Select
                value={connectionId}
                onValueChange={(value) => {
                  setConnectionId(value)
                  setDimensionIds({})
                }}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Choose a connection" />
                </SelectTrigger>
                <SelectContent>
                  {activeConnections.map((connection) => (
                    <SelectItem key={connection.id} value={connection.id}>
                      {connection.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {dimensionKinds.length ? (
              <div className="space-y-3 border-t border-border pt-4">
                <p className="text-xs text-muted-foreground">
                  {loadingDimensions ? "Loading dimensions…" : "Optional — tag every transaction from this scope."}
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {dimensionKinds.map((kind) => (
                    <div key={kind} className="space-y-1.5">
                      <Label className="text-xs font-normal text-muted-foreground">{DIMENSION_LABELS[kind]}</Label>
                      <Select
                        value={dimensionIds[kind] || "none"}
                        onValueChange={(id) => setDimensionIds((current) => ({ ...current, [kind]: id === "none" ? "" : id }))}
                        disabled={loadingDimensions}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          {(dimensions[kind] ?? []).map((value) => (
                            <SelectItem key={value.id} value={value.id}>
                              {value.fullyQualifiedName ?? value.name ?? value.id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" disabled={!canSave || saving} onClick={() => void save(false)}>
              {saving ? "Saving…" : "Save rule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={resyncPrompt !== null} onOpenChange={(next) => !next && setResyncPrompt(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Repoint synced transactions?</AlertDialogTitle>
            <AlertDialogDescription>
              {resyncPrompt} Existing records stay in the old accounting file — they are flagged for review so a bookkeeper can
              reconcile them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={(event) => {
                event.preventDefault()
                void save(true)
              }}
            >
              {saving ? "Saving…" : "Repoint and flag for review"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
