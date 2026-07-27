"use client"

import { useCallback, useEffect, useState } from "react"
import { formatDistanceToNow } from "date-fns"
import { ChevronRight, Download, Pencil, Plus, Shield } from "lucide-react"
import { toast } from "sonner"

import {
  connectAccountingProviderAction,
  createAccountingExportAction,
  getIntegrationsOverviewAction,
  type AccountingConnectionWithCapabilities,
  type AccountingRoute,
  type IntegrationsOverview,
} from "@/app/(app)/settings/integrations/actions"
import { unwrapAction } from "@/lib/action-result"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ACCOUNTING_PROVIDERS, ACCOUNTING_PROVIDER_KEYS, DIMENSION_LABELS } from "@/lib/integrations/accounting/catalog"
import type { AccountingDimensionKind, AccountingProviderKey } from "@/lib/integrations/accounting/provider"
import type { AccountingExportKind } from "@/lib/services/accounting-export"
import type { StripeConnectedAccount } from "@/lib/services/stripe-connected-accounts"
import { AccountingConnectionSheet } from "@/components/integrations/accounting-connection-sheet"
import { AccountingRoutingDialog } from "@/components/integrations/accounting-routing-dialog"
import { ConnectionStatusBadge, accountingStatusLabel, accountingStatusTone } from "@/components/integrations/connection-status"
import { StripeConnectionSheet, stripeStatus } from "@/components/integrations/stripe-connection-sheet"
import type { ConnectionTone } from "@/components/integrations/connection-status"

interface Props {
  /** Server-rendered seed so the Payments row never flashes empty. */
  initialStripe?: StripeConnectedAccount | null
}

const EXPORT_KINDS: { kind: AccountingExportKind; label: string }[] = [
  { kind: "ap", label: "A/P" },
  { kind: "job_cost", label: "Job cost" },
  { kind: "journal", label: "Journal" },
]

const SCOPE_LABELS: Record<AccountingRoute["scope"], string> = {
  org_default: "Organization default",
  division: "Division",
  community: "Community",
  project: "Project",
}

function SectionHeader({ label, description, action }: { label: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

function IntegrationRow({
  logoUrl,
  title,
  subtitle,
  meta,
  tone,
  statusLabel,
  onClick,
}: {
  logoUrl: string
  title: string
  subtitle: string
  meta?: string
  tone: ConnectionTone
  statusLabel: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
    >
      <div className="flex size-9 shrink-0 items-center justify-center border border-border bg-background p-1.5">
        <img src={logoUrl} alt="" className="size-full object-contain" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          <ConnectionStatusBadge tone={tone} label={statusLabel} />
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {meta ? <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:block">{meta}</span> : null}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Skeleton className="size-9 shrink-0" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-3 w-56" />
      </div>
    </div>
  )
}

export function IntegrationsPanel({ initialStripe = null }: Props) {
  const [overview, setOverview] = useState<IntegrationsOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [stripeOpen, setStripeOpen] = useState(false)
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null)
  const [routingRoute, setRoutingRoute] = useState<AccountingRoute | null>(null)
  const [routingOpen, setRoutingOpen] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [exportScope, setExportScope] = useState("all")
  const [startDate, setStartDate] = useState(() => `${new Date().getFullYear()}-01-01`)
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [exportingKind, setExportingKind] = useState<AccountingExportKind | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      setOverview(unwrapAction(await getIntegrationsOverviewAction()))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load integrations.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const connections = overview?.connections ?? []
  const routes = overview?.routes ?? []
  const canManage = overview?.canManageConnections ?? false
  const canManageRouting = overview?.canManageRouting ?? false
  const stripe = overview ? overview.stripe : initialStripe
  const activeConnection = connections.find((row) => row.id === activeConnectionId) ?? null

  const connect = async (providerKey: AccountingProviderKey) => {
    setConnecting(true)
    try {
      const result = unwrapAction(await connectAccountingProviderAction(providerKey))
      window.location.assign(result.authUrl)
    } catch (error) {
      toast.error(`Unable to connect ${ACCOUNTING_PROVIDERS[providerKey].name}`, {
        description: error instanceof Error ? error.message : "Try again.",
      })
      setConnecting(false)
    }
  }

  const downloadExport = async (kind: AccountingExportKind) => {
    setExportingKind(kind)
    try {
      const result = unwrapAction(
        await createAccountingExportAction({ kind, startDate, endDate, entityMapId: exportScope === "all" ? null : exportScope }),
      )
      const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }))
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = result.filename
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      toast.error("Unable to create export", { description: error instanceof Error ? error.message : "Try again." })
    } finally {
      setExportingKind(null)
    }
  }

  const openRouting = (route: AccountingRoute | null) => {
    setRoutingRoute(route)
    setRoutingOpen(true)
  }

  const addConnectionButton =
    ACCOUNTING_PROVIDER_KEYS.length === 1 ? (
      <Button size="sm" variant="outline" disabled={!canManage || connecting} onClick={() => void connect(ACCOUNTING_PROVIDER_KEYS[0])}>
        <Plus className="mr-1.5 size-3.5" />
        Add connection
      </Button>
    ) : (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" disabled={!canManage || connecting}>
            <Plus className="mr-1.5 size-3.5" />
            Add connection
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {ACCOUNTING_PROVIDER_KEYS.map((key) => (
            <DropdownMenuItem key={key} onSelect={() => void connect(key)}>
              <img src={ACCOUNTING_PROVIDERS[key].logoUrl} alt="" className="size-4 object-contain" />
              {ACCOUNTING_PROVIDERS[key].name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )

  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-4xl px-5 py-8 lg:px-8 lg:py-10">
        <div className="border border-border bg-muted/30 p-8 text-center">
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <Button size="sm" variant="outline" className="mt-4" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-10 px-5 py-8 lg:px-8 lg:py-10">
      <section className="space-y-3">
        <SectionHeader label="Payments" description="How clients pay the invoices Arc sends." />
        <div className="border border-border bg-card">
          {loading && !stripe ? (
            <RowSkeleton />
          ) : (
            <IntegrationRow
              logoUrl="/stripe.svg"
              title="Stripe"
              subtitle={stripe ? "Card and ACH payments on client invoices." : "Not connected — invoices can still be sent and paid offline."}
              meta={stripe?.charges_enabled && stripe?.payouts_enabled ? "Charges and payouts on" : undefined}
              tone={stripeStatus(stripe).tone}
              statusLabel={stripeStatus(stripe).label}
              onClick={() => setStripeOpen(true)}
            />
          )}
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeader
          label="Accounting"
          description="Books of record. Connect one file per legal entity — Arc routes each project to the right one."
          action={addConnectionButton}
        />

        {!loading && !canManage ? (
          <div className="flex flex-col items-center border border-border bg-muted/30 px-6 py-10 text-center">
            <Shield className="size-8 text-muted-foreground/40" />
            <p className="mt-3 max-w-sm text-sm text-muted-foreground">
              Organization admin access is required to view and manage accounting connections.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border border border-border bg-card">
            {loading ? (
              <>
                <RowSkeleton />
                <RowSkeleton />
              </>
            ) : connections.length === 0 ? (
              <div className="flex flex-col items-center px-6 py-10 text-center">
                <div className="flex size-10 items-center justify-center border border-border bg-background p-2">
                  <img src={ACCOUNTING_PROVIDERS.qbo.logoUrl} alt="" className="size-full object-contain" />
                </div>
                <p className="mt-3 text-sm font-medium">No accounting connection</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Arc financials work without one. Connect a provider to push invoices, bills, payments, and expenses to your books —
                  or keep using the CSV exports below.
                </p>
                <div className="mt-4">{addConnectionButton}</div>
              </div>
            ) : (
              connections.map((connection) => (
                <AccountingRow key={connection.id} connection={connection} onOpen={() => setActiveConnectionId(connection.id)} />
              ))
            )}
          </div>
        )}
      </section>

      {canManageRouting && connections.length > 0 ? (
        <section className="space-y-3">
          <SectionHeader
            label="Routing"
            description="Which accounting file each project posts to. Project beats community, community beats division, division beats the organization default."
            action={
              <Button size="sm" variant="outline" onClick={() => openRouting(null)}>
                <Plus className="mr-1.5 size-3.5" />
                Add rule
              </Button>
            }
          />
          {routes.length === 0 ? (
            <div className="border border-border bg-card px-4 py-6 text-center">
              <p className="text-sm text-muted-foreground">
                No routing rules yet — nothing syncs until at least an organization default exists.
              </p>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => openRouting(null)}>
                Add the organization default
              </Button>
            </div>
          ) : (
            <div className="border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-40">Scope</TableHead>
                    <TableHead>Applies to</TableHead>
                    <TableHead>Posts to</TableHead>
                    <TableHead>Dimensions</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {routes.map((route) => {
                    const connection = connections.find((row) => row.id === route.connection_id)
                    const dimensionKinds = Object.keys(route.dimensions ?? {}) as AccountingDimensionKind[]
                    return (
                      <TableRow key={route.id}>
                        <TableCell className="text-xs text-muted-foreground">{SCOPE_LABELS[route.scope]}</TableCell>
                        <TableCell className="text-sm">{route.scopeName ?? "Every unmapped project"}</TableCell>
                        <TableCell className="text-sm">{connection?.label ?? "Missing connection"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {dimensionKinds.length ? dimensionKinds.map((kind) => DIMENSION_LABELS[kind]).join(", ") : "—"}
                        </TableCell>
                        <TableCell>
                          {route.scope === "project" ? null : (
                            <Button size="icon" variant="ghost" className="size-7" onClick={() => openRouting(route)}>
                              <Pencil className="size-3" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      ) : null}

      <section className="space-y-3">
        <SectionHeader label="Exports" description="CSV for accounting systems Arc does not connect to. Works with or without a connection." />
        <div className="flex flex-wrap items-end gap-3 border border-border bg-card p-4">
          <div className="space-y-1.5">
            <Label className="text-xs font-normal text-muted-foreground">Scope</Label>
            <Select value={exportScope} onValueChange={setExportScope}>
              <SelectTrigger className="h-8 w-52 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {routes.map((route) => {
                  const connection = connections.find((row) => row.id === route.connection_id)
                  return (
                    <SelectItem key={route.id} value={route.id}>
                      {route.scopeName ?? SCOPE_LABELS[route.scope]} · {connection?.label ?? "Accounting entity"}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-normal text-muted-foreground">From</Label>
            <Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="h-8 w-40 text-xs" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-normal text-muted-foreground">Through</Label>
            <Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="h-8 w-40 text-xs" />
          </div>
          <div className="flex flex-wrap gap-2">
            {EXPORT_KINDS.map(({ kind, label }) => (
              <Button key={kind} size="sm" variant="outline" disabled={exportingKind !== null} onClick={() => void downloadExport(kind)}>
                <Download className="mr-1.5 size-3.5" />
                {exportingKind === kind ? "Building…" : label}
              </Button>
            ))}
          </div>
        </div>
      </section>

      <StripeConnectionSheet
        connection={stripe}
        open={stripeOpen}
        onOpenChange={setStripeOpen}
        canManage={canManage}
        onChanged={(next) => setOverview((current) => (current ? { ...current, stripe: next } : current))}
      />

      <AccountingConnectionSheet
        connection={activeConnection}
        open={activeConnection !== null}
        onOpenChange={(next) => !next && setActiveConnectionId(null)}
        onChanged={() => void load()}
      />

      <AccountingRoutingDialog
        open={routingOpen}
        onOpenChange={setRoutingOpen}
        route={routingRoute}
        connections={connections}
        scopes={overview?.scopes ?? { divisions: [], communities: [] }}
        onSaved={() => void load()}
      />
    </div>
  )
}

function AccountingRow({ connection, onOpen }: { connection: AccountingConnectionWithCapabilities; onOpen: () => void }) {
  const provider = ACCOUNTING_PROVIDERS[connection.provider]
  const companyFile = connection.external_account_name ?? connection.external_account_id
  return (
    <IntegrationRow
      logoUrl={provider.logoUrl}
      title={connection.label}
      subtitle={connection.last_error ? connection.last_error : `${provider.name} · ${companyFile}`}
      meta={connection.last_sync_at ? `Synced ${formatDistanceToNow(new Date(connection.last_sync_at))} ago` : "Never synced"}
      tone={accountingStatusTone(connection.status)}
      statusLabel={accountingStatusLabel(connection.status)}
      onClick={onOpen}
    />
  )
}
