"use client"

import { useCallback, useEffect, useState } from "react"
import { Download, Pencil, Plug, RefreshCcw, Save, Unplug } from "lucide-react"
import { toast } from "sonner"
import { connectQBOAction, createAccountingExportAction, disconnectAccountingConnectionAction, listAccountingConnectionsAction, listAccountingDimensionValuesAction, listAccountingEntityMapsAction, listAccountingScopeOptionsAction, refreshAccountingConnectionAction, updateAccountingConnectionLabelAction, upsertAccountingEntityMapAction } from "@/app/(app)/settings/integrations/actions"
import type { AccountingConnectionDTO } from "@/lib/services/accounting-connections"
import { unwrapAction } from "@/lib/action-result"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { AccountingExportKind } from "@/lib/services/accounting-export"

function formatDate(value: string | null) {
  if (!value) return "Never"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString()
}

export function AccountingConnectionsPanel() {
  const [connections, setConnections] = useState<AccountingConnectionDTO[]>([])
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [maps, setMaps] = useState<Awaited<ReturnType<typeof listAccountingEntityMapsAction>>>([])
  const [startDate, setStartDate] = useState(() => `${new Date().getFullYear()}-01-01`)
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [exportMapId, setExportMapId] = useState("all")
  const [scopes, setScopes] = useState<{ divisions: { id: string; name: string }[]; communities: { id: string; name: string }[] }>({ divisions: [], communities: [] })
  const [mapDraft, setMapDraft] = useState({ id: "", scope: "org_default", scopeId: "", connectionId: "", classId: "", customerId: "" })
  const [dimensions, setDimensions] = useState<{ classes: { id: string; name: string | null }[]; customers: { id: string; name: string | null }[] }>({ classes: [], customers: [] })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [rows, entityMaps, scopeOptions] = await Promise.all([listAccountingConnectionsAction(), listAccountingEntityMapsAction().catch(() => []), listAccountingScopeOptionsAction().catch(() => ({ divisions: [], communities: [] }))])
      setConnections(rows)
      setMaps(entityMaps)
      setLabels(Object.fromEntries(rows.map((row) => [row.id, row.label])))
      setScopes(scopeOptions)
      setMapDraft((current) => ({ ...current, connectionId: current.connectionId || rows.find((row) => row.status === "active")?.id || "" }))
    } catch (error) {
      toast.error("Unable to load accounting connections", { description: error instanceof Error ? error.message : "Try again." })
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!mapDraft.connectionId) { setDimensions({ classes: [], customers: [] }); return }
    Promise.all([
      listAccountingDimensionValuesAction(mapDraft.connectionId, "class"),
      listAccountingDimensionValuesAction(mapDraft.connectionId, "customer"),
    ]).then(([classes, customers]) => setDimensions({ classes, customers })).catch(() => setDimensions({ classes: [], customers: [] }))
  }, [mapDraft.connectionId])

  const connect = async () => {
    try {
      const result = unwrapAction(await connectQBOAction())
      window.location.assign(result.authUrl)
    } catch (error) { toast.error("Unable to start QuickBooks connection", { description: error instanceof Error ? error.message : "Try again." }) }
  }

  const saveLabel = async (connectionId: string) => {
    setBusyId(connectionId)
    try {
      unwrapAction(await updateAccountingConnectionLabelAction({ connectionId, label: labels[connectionId] ?? "" }))
      toast.success("Connection label updated")
      await load()
    } catch (error) { toast.error("Unable to update label", { description: error instanceof Error ? error.message : "Try again." }) }
    finally { setBusyId(null) }
  }

  const disconnect = async (connectionId: string) => {
    setBusyId(connectionId)
    try {
      unwrapAction(await disconnectAccountingConnectionAction(connectionId))
      toast.success("Accounting connection disconnected")
      await load()
    } catch (error) { toast.error("Unable to disconnect", { description: error instanceof Error ? error.message : "Try again." }) }
    finally { setBusyId(null) }
  }

  const refreshToken = async (connectionId: string) => {
    setBusyId(connectionId)
    try { unwrapAction(await refreshAccountingConnectionAction(connectionId)); toast.success("QuickBooks token refreshed"); await load() }
    catch (error) { toast.error("Unable to refresh token", { description: error instanceof Error ? error.message : "Try again." }) }
    finally { setBusyId(null) }
  }

  const downloadExport = async (kind: AccountingExportKind) => {
    setBusyId(`export:${kind}`)
    try {
      const result = unwrapAction(await createAccountingExportAction({ kind, startDate, endDate, entityMapId: exportMapId === "all" ? null : exportMapId }))
      const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }))
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = result.filename
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) { toast.error("Unable to create export", { description: error instanceof Error ? error.message : "Try again." }) }
    finally { setBusyId(null) }
  }

  const editMap = (map: (typeof maps)[number]) => {
    const values = (map.dimensions as Record<string, { id?: string }> | null) ?? {}
    setMapDraft({ id: map.id, scope: map.scope, scopeId: map.project_id ?? map.community_id ?? map.division_id ?? "", connectionId: map.connection_id, classId: values.class?.id ?? "", customerId: values.customer?.id ?? "" })
  }

  const saveMap = async () => {
    if (!mapDraft.connectionId) return
    setBusyId("map")
    try {
      const classValue = dimensions.classes.find((row) => row.id === mapDraft.classId)
      const customerValue = dimensions.customers.find((row) => row.id === mapDraft.customerId)
      unwrapAction(await upsertAccountingEntityMapAction({
        id: mapDraft.id || undefined,
        connectionId: mapDraft.connectionId,
        divisionId: mapDraft.scope === "division" ? mapDraft.scopeId : null,
        communityId: mapDraft.scope === "community" ? mapDraft.scopeId : null,
        dimensions: {
          ...(classValue ? { class: classValue } : {}),
          ...(customerValue ? { customer: customerValue } : {}),
        },
      }))
      toast.success("Accounting mapping saved")
      setMapDraft((current) => ({ ...current, id: "", classId: "", customerId: "" }))
      await load()
    } catch (error) { toast.error("Unable to save mapping", { description: error instanceof Error ? error.message : "Try again." }) }
    finally { setBusyId(null) }
  }

  return <div className="space-y-3">
    <div className="flex items-center justify-between gap-3">
      <div><h3 className="text-sm font-medium">Accounting connections</h3><p className="text-xs text-muted-foreground">One connection per legal entity or accounting file.</p></div>
      <div className="flex items-center gap-2"><Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}><RefreshCcw className="mr-1.5 size-3.5" />Refresh</Button><Button size="sm" onClick={connect}><Plug className="mr-1.5 size-3.5" />Connect QuickBooks</Button></div>
    </div>
    {loading ? <div className="flex h-24 items-center justify-center"><Spinner /></div> : connections.length === 0 ? <div className="border border-dashed p-6 text-center text-sm text-muted-foreground">No accounting connection. Arc financials continue to work, and accounting exports remain available.</div> : <div className="border"><Table>
      <TableHeader><TableRow><TableHead>Legal entity</TableHead><TableHead>Provider</TableHead><TableHead>Company</TableHead><TableHead>Status</TableHead><TableHead>Last sync</TableHead><TableHead>Health</TableHead><TableHead className="w-24" /></TableRow></TableHeader>
      <TableBody>{connections.map((connection) => <TableRow key={connection.id}>
        <TableCell><div className="flex min-w-56 items-center gap-1.5"><Input className="h-8" value={labels[connection.id] ?? ""} onChange={(event) => setLabels((current) => ({ ...current, [connection.id]: event.target.value }))} /><Button size="icon" variant="ghost" disabled={busyId === connection.id || labels[connection.id] === connection.label} onClick={() => void saveLabel(connection.id)}><Save className="size-3.5" /></Button></div></TableCell>
        <TableCell>QuickBooks Online</TableCell><TableCell>{connection.external_account_name ?? connection.external_account_id}</TableCell><TableCell><Badge variant={connection.status === "active" ? "secondary" : "destructive"}>{connection.status}</Badge></TableCell><TableCell className="text-xs text-muted-foreground">{formatDate(connection.last_sync_at)}</TableCell><TableCell className="max-w-48 truncate text-xs text-muted-foreground" title={connection.last_error ?? undefined}>{connection.last_error ?? "Healthy"}</TableCell><TableCell><div className="flex"><Button size="icon" variant="ghost" title="Refresh token" disabled={busyId === connection.id || connection.status !== "active"} onClick={() => void refreshToken(connection.id)}><RefreshCcw className="size-3.5" /></Button><Button size="icon" variant="ghost" title="Disconnect" disabled={busyId === connection.id || connection.status !== "active"} onClick={() => void disconnect(connection.id)}><Unplug className="size-3.5" /></Button></div></TableCell>
      </TableRow>)}</TableBody>
    </Table></div>}
    <div className="space-y-2 border-t pt-3"><div><h3 className="text-sm font-medium">Entity map</h3><p className="text-xs text-muted-foreground">Project, community, and division overrides resolve above the organization default.</p></div>
      {connections.some((row) => row.status === "active") ? <div className="grid gap-2 border p-3 md:grid-cols-5">
        <Select value={mapDraft.scope} onValueChange={(scope) => setMapDraft((current) => ({ ...current, scope, scopeId: "" }))}><SelectTrigger className="h-8"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="org_default">Organization default</SelectItem>{scopes.divisions.length ? <SelectItem value="division">Division</SelectItem> : null}{scopes.communities.length ? <SelectItem value="community">Community</SelectItem> : null}</SelectContent></Select>
        {mapDraft.scope === "division" || mapDraft.scope === "community" ? <Select value={mapDraft.scopeId} onValueChange={(scopeId) => setMapDraft((current) => ({ ...current, scopeId }))}><SelectTrigger className="h-8"><SelectValue placeholder="Choose scope" /></SelectTrigger><SelectContent>{(mapDraft.scope === "division" ? scopes.divisions : scopes.communities).map((scope) => <SelectItem key={scope.id} value={scope.id}>{scope.name}</SelectItem>)}</SelectContent></Select> : <div className="flex h-8 items-center text-xs text-muted-foreground">All unmapped projects</div>}
        <Select value={mapDraft.connectionId} onValueChange={(connectionId) => setMapDraft((current) => ({ ...current, connectionId, classId: "", customerId: "" }))}><SelectTrigger className="h-8"><SelectValue placeholder="Connection" /></SelectTrigger><SelectContent>{connections.filter((row) => row.status === "active").map((connection) => <SelectItem key={connection.id} value={connection.id}>{connection.label}</SelectItem>)}</SelectContent></Select>
        <Select value={mapDraft.classId || "none"} onValueChange={(classId) => setMapDraft((current) => ({ ...current, classId: classId === "none" ? "" : classId }))}><SelectTrigger className="h-8"><SelectValue placeholder="Class" /></SelectTrigger><SelectContent><SelectItem value="none">No class</SelectItem>{dimensions.classes.map((row) => <SelectItem key={row.id} value={row.id}>{row.name ?? row.id}</SelectItem>)}</SelectContent></Select>
        <div className="flex gap-1"><Select value={mapDraft.customerId || "none"} onValueChange={(customerId) => setMapDraft((current) => ({ ...current, customerId: customerId === "none" ? "" : customerId }))}><SelectTrigger className="h-8 flex-1"><SelectValue placeholder="Customer" /></SelectTrigger><SelectContent><SelectItem value="none">No customer</SelectItem>{dimensions.customers.map((row) => <SelectItem key={row.id} value={row.id}>{row.name ?? row.id}</SelectItem>)}</SelectContent></Select><Button size="icon" className="size-8" disabled={busyId === "map" || !mapDraft.connectionId || ((mapDraft.scope === "division" || mapDraft.scope === "community") && !mapDraft.scopeId)} onClick={() => void saveMap()}><Save className="size-3.5" /></Button></div>
      </div> : null}
      {maps.length === 0 ? <p className="text-xs text-muted-foreground">No entity mappings configured.</p> : <div className="border"><Table><TableHeader><TableRow><TableHead>Scope</TableHead><TableHead>Name</TableHead><TableHead>Connection</TableHead><TableHead>Dimensions</TableHead></TableRow></TableHeader><TableBody>{maps.map((map) => {
        const connection = connections.find((row) => row.id === map.connection_id)
        const division = Array.isArray(map.division) ? map.division[0] : map.division
        const community = Array.isArray(map.community) ? map.community[0] : map.community
        const project = Array.isArray(map.project) ? map.project[0] : map.project
        return <TableRow key={map.id}><TableCell>{map.scope.replace("_", " ")}</TableCell><TableCell>{project?.name ?? community?.name ?? division?.name ?? "Organization default"}</TableCell><TableCell>{connection?.label ?? "Unknown"}</TableCell><TableCell className="font-mono text-xs"><div className="flex items-center justify-between gap-2"><span>{Object.keys((map.dimensions as Record<string, unknown> | null) ?? {}).join(", ") || "—"}</span>{map.scope !== "project" ? <Button size="icon" variant="ghost" className="size-7" onClick={() => editMap(map)}><Pencil className="size-3" /></Button> : null}</div></TableCell></TableRow>
      })}</TableBody></Table></div>}
    </div>
    <div className="space-y-2 border-t pt-3"><div><h3 className="text-sm font-medium">Accounting exports</h3><p className="text-xs text-muted-foreground">Connection-free CSV exports for external accounting systems.</p></div><div className="flex flex-wrap items-end gap-2"><label className="space-y-1 text-xs">Entity scope<Select value={exportMapId} onValueChange={setExportMapId}><SelectTrigger className="w-52"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All projects</SelectItem>{maps.map((map) => { const connection = connections.find((row) => row.id === map.connection_id); return <SelectItem key={map.id} value={map.id}>{map.scope.replace("_", " ")} · {connection?.label ?? "Accounting entity"}</SelectItem> })}</SelectContent></Select></label><label className="space-y-1 text-xs">From<Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label><label className="space-y-1 text-xs">Through<Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>{(["ap","job_cost","journal"] as AccountingExportKind[]).map((kind) => <Button key={kind} size="sm" variant="outline" disabled={busyId?.startsWith("export:")} onClick={() => void downloadExport(kind)}><Download className="mr-1.5 size-3.5" />{kind === "ap" ? "AP" : kind === "job_cost" ? "Job cost" : "Journal"}</Button>)}</div></div>
  </div>
}
