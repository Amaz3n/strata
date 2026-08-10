"use client"

import { useCallback, useEffect, useState } from "react"
import { formatDistanceToNow } from "date-fns"
import { Check, FileSpreadsheet, Pencil, RefreshCcw, Unplug, X } from "lucide-react"
import { toast } from "sonner"

import {
  disconnectAccountingConnectionAction,
  getAccountingConnectionConfigurationAction,
  refreshAccountingConnectionAction,
  updateAccountingConnectionLabelAction,
  updateAccountingConnectionSettingsAction,
  type AccountingConnectionWithCapabilities,
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { ACCOUNTING_PROVIDERS, ACCOUNT_KIND_LABELS } from "@/lib/integrations/accounting/catalog"
import type { AccountingAccountKind, AccountingDimensionValue } from "@/lib/integrations/accounting/provider"
import { accountingStatusLabel, accountingStatusTone, ConnectionStatusBadge } from "@/components/integrations/connection-status"

interface Props {
  connection: AccountingConnectionWithCapabilities | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}

interface SettingsDraft {
  auto_sync: boolean
  sync_payments: boolean
  invoice_number_sync: boolean
  customer_sync_mode: "create_new" | "match_existing"
  project_mapping_mode: "customer" | "sub_customer"
  default_income_account_id: string | null
  default_expense_account_id: string | null
  default_payment_account_id: string | null
  default_ap_account_id: string | null
}

const ACCOUNT_FIELDS: { kind: AccountingAccountKind; key: keyof SettingsDraft }[] = [
  { kind: "income", key: "default_income_account_id" },
  { kind: "expense", key: "default_expense_account_id" },
  { kind: "payment", key: "default_payment_account_id" },
  { kind: "ap", key: "default_ap_account_id" },
]

function toDraft(settings: Record<string, unknown>): SettingsDraft {
  const readId = (key: string) => (typeof settings[key] === "string" ? (settings[key] as string) : null)
  return {
    auto_sync: settings.auto_sync !== false,
    sync_payments: settings.sync_payments !== false,
    invoice_number_sync: settings.invoice_number_sync === true,
    customer_sync_mode: settings.customer_sync_mode === "match_existing" ? "match_existing" : "create_new",
    project_mapping_mode: settings.project_mapping_mode === "sub_customer" ? "sub_customer" : "customer",
    default_income_account_id: readId("default_income_account_id"),
    default_expense_account_id: readId("default_expense_account_id"),
    default_payment_account_id: readId("default_payment_account_id"),
    default_ap_account_id: readId("default_ap_account_id"),
  }
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-xs tabular-nums">{value}</span>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{children}</h3>
}

function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} className="mt-0.5 shrink-0" />
    </div>
  )
}

export function AccountingConnectionSheet({ connection, open, onOpenChange, onChanged }: Props) {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [baseline, setBaseline] = useState<SettingsDraft | null>(null)
  const [accounts, setAccounts] = useState<Partial<Record<AccountingAccountKind, AccountingDimensionValue[]>>>({})
  const [labelDraft, setLabelDraft] = useState("")
  const [editingLabel, setEditingLabel] = useState(false)
  const [busy, setBusy] = useState<"save" | "refresh" | "disconnect" | "label" | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  const connectionId = connection?.id ?? null
  const provider = connection ? ACCOUNTING_PROVIDERS[connection.provider] : null

  const loadConfiguration = useCallback(async () => {
    if (!connectionId) return
    setLoading(true)
    setLoadError(null)
    try {
      const config = unwrapAction(await getAccountingConnectionConfigurationAction(connectionId))
      const next = toDraft((config.settings ?? {}) as unknown as Record<string, unknown>)
      setDraft(next)
      setBaseline(next)
      setAccounts(config.accounts)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load connection settings.")
    } finally {
      setLoading(false)
    }
  }, [connectionId])

  useEffect(() => {
    if (!open || !connectionId) return
    setEditingLabel(false)
    setLabelDraft(connection?.label ?? "")
    void loadConfiguration()
  }, [open, connectionId, connection?.label, loadConfiguration])

  if (!connection || !provider) return null

  const dirty = Boolean(draft && baseline) && JSON.stringify(draft) !== JSON.stringify(baseline)
  const update = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current))

  const saveLabel = async () => {
    const trimmed = labelDraft.trim()
    if (!trimmed || trimmed === connection.label) {
      setEditingLabel(false)
      setLabelDraft(connection.label)
      return
    }
    setBusy("label")
    try {
      unwrapAction(await updateAccountingConnectionLabelAction({ connectionId: connection.id, label: trimmed }))
      setEditingLabel(false)
      onChanged()
    } catch (error) {
      toast.error("Unable to rename connection", { description: error instanceof Error ? error.message : "Try again." })
    } finally {
      setBusy(null)
    }
  }

  const saveSettings = async () => {
    if (!draft) return
    setBusy("save")
    try {
      unwrapAction(await updateAccountingConnectionSettingsAction({ connectionId: connection.id, settings: draft }))
      setBaseline(draft)
      toast.success("Settings saved")
      onChanged()
    } catch (error) {
      toast.error("Unable to save settings", { description: error instanceof Error ? error.message : "Try again." })
    } finally {
      setBusy(null)
    }
  }

  const refresh = async () => {
    setBusy("refresh")
    try {
      unwrapAction(await refreshAccountingConnectionAction(connection.id))
      toast.success(`${provider.name} reauthorized`)
      onChanged()
    } catch (error) {
      toast.error("Unable to refresh connection", { description: error instanceof Error ? error.message : "Try again." })
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async () => {
    setBusy("disconnect")
    try {
      unwrapAction(await disconnectAccountingConnectionAction(connection.id))
      toast.success("Connection disconnected")
      setConfirmDisconnect(false)
      onOpenChange(false)
      onChanged()
    } catch (error) {
      toast.error("Unable to disconnect", { description: error instanceof Error ? error.message : "Try again." })
    } finally {
      setBusy(null)
    }
  }

  const lastSync = connection.last_sync_at ? `${formatDistanceToNow(new Date(connection.last_sync_at))} ago` : "Never"

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          mobileFullscreen
          className="flex flex-col gap-0 p-0 sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-lg"
        >
          <SheetHeader className="space-y-0 border-b border-border px-5 py-4">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center border border-border bg-background p-1.5">
                {provider.logoUrl ? (
                  <img src={provider.logoUrl} alt="" className="size-full object-contain" />
                ) : (
                  <FileSpreadsheet className="size-full text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                {editingLabel ? (
                  <div className="flex items-center gap-1">
                    <Input
                      autoFocus
                      value={labelDraft}
                      onChange={(event) => setLabelDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void saveLabel()
                        if (event.key === "Escape") {
                          setEditingLabel(false)
                          setLabelDraft(connection.label)
                        }
                      }}
                      className="h-7 text-sm"
                    />
                    <Button size="icon" variant="ghost" className="size-7 shrink-0" disabled={busy === "label"} onClick={() => void saveLabel()}>
                      <Check className="size-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 shrink-0"
                      onClick={() => {
                        setEditingLabel(false)
                        setLabelDraft(connection.label)
                      }}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <SheetTitle className="truncate text-sm font-medium">{connection.label}</SheetTitle>
                    <Button size="icon" variant="ghost" className="size-6 shrink-0 text-muted-foreground" onClick={() => setEditingLabel(true)}>
                      <Pencil className="size-3" />
                    </Button>
                    <ConnectionStatusBadge tone={accountingStatusTone(connection.status)} label={accountingStatusLabel(connection.status)} />
                  </div>
                )}
                <SheetDescription className="mt-0.5 truncate text-xs">
                  {provider.name} · {connection.external_account_name ?? connection.external_account_id}
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-6 px-5 py-5">
              <div className="divide-y divide-border">
                <Fact label="Company file" value={connection.external_account_id} />
                <Fact label="Connected" value={new Date(connection.connected_at).toLocaleDateString()} />
                <Fact label="Last sync" value={lastSync} />
              </div>

              {connection.last_error ? (
                <div className="border border-destructive/20 bg-destructive/[0.04] p-3">
                  <p className="text-xs font-medium text-destructive">Last error</p>
                  <p className="mt-1 text-xs text-muted-foreground">{connection.last_error}</p>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy !== null || connection.status === "disconnected"} onClick={() => void refresh()}>
                  <RefreshCcw className="mr-1.5 size-3.5" />
                  {connection.status === "expired" ? "Reauthorize" : "Refresh token"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={busy !== null || connection.status === "disconnected"}
                  onClick={() => setConfirmDisconnect(true)}
                >
                  <Unplug className="mr-1.5 size-3.5" />
                  Disconnect
                </Button>
              </div>

              {loading ? (
                <div className="space-y-3">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <Skeleton key={index} className="h-12 w-full" />
                  ))}
                </div>
              ) : loadError ? (
                <div className="border border-border bg-muted/30 p-4 text-center">
                  <p className="text-xs text-muted-foreground">{loadError}</p>
                  <Button size="sm" variant="outline" className="mt-3" onClick={() => void loadConfiguration()}>
                    Try again
                  </Button>
                </div>
              ) : draft ? (
                <>
                  <section className="space-y-1">
                    <SectionLabel>Sync</SectionLabel>
                    <div className="divide-y divide-border">
                      <ToggleRow
                        label="Automatic sync"
                        description={`Send new invoices, bills, and expenses to ${provider.name} as they post.`}
                        checked={draft.auto_sync}
                        onCheckedChange={(checked) => update("auto_sync", checked)}
                      />
                      <ToggleRow
                        label="Sync payments"
                        description="Push payments and deposits recorded in Arc."
                        checked={draft.sync_payments}
                        onCheckedChange={(checked) => update("sync_payments", checked)}
                      />
                      {connection.capabilities.supportsInvoiceDocNumberSync ? (
                        <ToggleRow
                          label="Sync invoice numbers"
                          description={`Keep Arc invoice numbers identical to ${provider.name}.`}
                          checked={draft.invoice_number_sync}
                          onCheckedChange={(checked) => update("invoice_number_sync", checked)}
                        />
                      ) : null}
                    </div>
                  </section>

                  <section className="space-y-3">
                    <SectionLabel>Customers &amp; projects</SectionLabel>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-normal text-muted-foreground">Customer handling</Label>
                        <Select value={draft.customer_sync_mode} onValueChange={(value) => update("customer_sync_mode", value as SettingsDraft["customer_sync_mode"])}>
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="create_new">Create when missing</SelectItem>
                            <SelectItem value="match_existing">Match existing first</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {connection.capabilities.supportsSubCustomers ? (
                        <div className="space-y-1.5">
                          <Label className="text-xs font-normal text-muted-foreground">Projects post as</Label>
                          <Select value={draft.project_mapping_mode} onValueChange={(value) => update("project_mapping_mode", value as SettingsDraft["project_mapping_mode"])}>
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="customer">A customer</SelectItem>
                              <SelectItem value="sub_customer">A sub-customer of the client</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      ) : null}
                    </div>
                  </section>

                  <section className="space-y-3">
                    <SectionLabel>Default accounts</SectionLabel>
                    <p className="text-xs text-muted-foreground">Used when a cost code or line has no account of its own.</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {ACCOUNT_FIELDS.map(({ kind, key }) => (
                        <div key={kind} className="space-y-1.5">
                          <Label className="text-xs font-normal text-muted-foreground">{ACCOUNT_KIND_LABELS[kind]}</Label>
                          <Select
                            value={(draft[key] as string | null) ?? "none"}
                            onValueChange={(value) => update(key, (value === "none" ? null : value) as SettingsDraft[typeof key])}
                          >
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">No default</SelectItem>
                              {(accounts[kind] ?? []).map((account) => (
                                <SelectItem key={account.id} value={account.id}>
                                  {account.fullyQualifiedName ?? account.name ?? account.id}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                  </section>
                </>
              ) : null}
            </div>
          </div>

          {draft && !loading && !loadError ? (
            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-5 py-3">
              <p className="text-xs text-muted-foreground">{dirty ? "Unsaved changes" : "All changes saved"}</p>
              <Button size="sm" disabled={!dirty || busy !== null} onClick={() => void saveSettings()}>
                {busy === "save" ? "Saving…" : "Save changes"}
              </Button>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {connection.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Arc stops pushing to this {provider.name} company file. Records already synced stay in both systems, and any routing rule
              pointing here will need a new connection.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "disconnect"}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === "disconnect"}
              onClick={(event) => {
                event.preventDefault()
                void disconnect()
              }}
            >
              {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
