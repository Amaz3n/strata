'use client'

import { useCallback, useEffect, useState, useTransition } from "react"
import { AlertCircle, CheckCircle2, ExternalLink, RefreshCw } from "lucide-react"

import {
  connectQBOAction,
  disconnectQBOAction,
  getQBOAccountingSetupAction,
  getQBOConnectionAction,
  getQBODiagnosticsAction,
  refreshQBOTokenAction,
  retryFailedQBOJobsAction,
  updateQBOSettingsAction,
} from "@/app/(app)/settings/integrations/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { QBOConnection } from "@/lib/services/qbo-connection"
import { cn } from "@/lib/utils"

interface Props {
  connection: QBOConnection | null
  onConnectionChange?: (connection: QBOConnection | null) => void
}

type QBOOAuthMessage = {
  type: "arc:qbo-oauth-complete"
  status: "success" | "error"
  redirectPath?: string
}

export function QBOConnectionCard({ connection, onConnectionChange }: Props) {
  const [isConnecting, setIsConnecting] = useState(false)
  const [isDisconnecting, startDisconnect] = useTransition()
  const [isUpdatingSettings, startUpdate] = useTransition()
  const [isRefreshingToken, startTokenRefresh] = useTransition()
  const [isRetryingFailed, startRetryFailed] = useTransition()
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<{
    outbox?: { pending_or_processing?: number; failed?: number; recent_failures?: Array<{ job_type: string; last_error: string | null; updated_at: string | null }> }
    invoices?: { failed_sync_count?: number }
    connection?: { last_error?: string | null } | null
  } | null>(null)
  const [setup, setSetup] = useState<Awaited<ReturnType<typeof getQBOAccountingSetupAction>> | null>(null)
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(false)
  const [settings, setSettings] = useState(() => ({
    auto_sync: connection?.settings?.auto_sync ?? true,
    sync_payments: connection?.settings?.sync_payments ?? true,
    invoice_number_sync: connection?.settings?.invoice_number_sync ?? true,
    default_income_account_id: connection?.settings?.default_income_account_id ?? "",
    default_expense_account_id: connection?.settings?.default_expense_account_id ?? "",
    default_payment_account_id: connection?.settings?.default_payment_account_id ?? "",
    default_credit_card_account_id: connection?.settings?.default_credit_card_account_id ?? "",
    default_ap_account_id: connection?.settings?.default_ap_account_id ?? "",
    project_mapping_mode: connection?.settings?.project_mapping_mode ?? "customer",
  }))

  useEffect(() => {
    setSettings({
      auto_sync: connection?.settings?.auto_sync ?? true,
      sync_payments: connection?.settings?.sync_payments ?? true,
      invoice_number_sync: connection?.settings?.invoice_number_sync ?? true,
      default_income_account_id: connection?.settings?.default_income_account_id ?? "",
      default_expense_account_id: connection?.settings?.default_expense_account_id ?? "",
      default_payment_account_id: connection?.settings?.default_payment_account_id ?? "",
      default_credit_card_account_id: connection?.settings?.default_credit_card_account_id ?? "",
      default_ap_account_id: connection?.settings?.default_ap_account_id ?? "",
      project_mapping_mode: connection?.settings?.project_mapping_mode ?? "customer",
    })
  }, [connection])

  const expiresInLabel = (() => {
    if (!connection?.token_expires_at) return null
    const expires = new Date(connection.token_expires_at).getTime()
    const diffHours = Math.round((expires - Date.now()) / (1000 * 60 * 60))
    if (diffHours < 0) return "Expired"
    if (diffHours < 24) return `${diffHours}h`
    const days = Math.ceil(diffHours / 24)
    return `${days}d`
  })()

  const handleConnect = async () => {
    setIsConnecting(true)
    try {
      const result = await connectQBOAction()
      if (result?.authUrl) {
        const secure = window.location.protocol === "https:"
        if (result.state) {
          document.cookie = [
            `qbo_oauth_state=${result.state}`,
            "Path=/",
            "SameSite=Lax",
            "Max-Age=600",
            secure ? "Secure" : "",
          ].filter(Boolean).join(";")
        }
        document.cookie = [
          "qbo_oauth_popup=1",
          "Path=/",
          "SameSite=Lax",
          "Max-Age=600",
          secure ? "Secure" : "",
        ].filter(Boolean).join(";")

        const popupWidth = 640
        const popupHeight = 760
        const left = Math.round(window.screenX + (window.outerWidth - popupWidth) / 2)
        const top = Math.round(window.screenY + (window.outerHeight - popupHeight) / 2)
        const popup = window.open(
          result.authUrl,
          "arc-qbo-oauth",
          `width=${popupWidth},height=${popupHeight},left=${left},top=${top},resizable=yes,scrollbars=yes`,
        )

        if (popup) {
          popup.focus()
          return
        }

        document.cookie = [
          "qbo_oauth_popup=",
          "Path=/",
          "SameSite=Lax",
          "Max-Age=0",
          secure ? "Secure" : "",
        ].filter(Boolean).join(";")
        window.location.href = result.authUrl
      }
    } catch (err) {
      console.error("Failed to start QBO connect flow", err)
    } finally {
      setIsConnecting(false)
    }
  }

  const handleDisconnect = () => {
    if (!confirm("Disconnect QuickBooks? Existing synced data will remain in QBO.")) return
    startDisconnect(async () => {
      await disconnectQBOAction()
      window.location.reload()
    })
  }

  const loadDiagnostics = useCallback(async () => {
    if (!connection) return
    setLoadingDiagnostics(true)
    setError(null)
    try {
      const data = await getQBODiagnosticsAction()
      setDiagnostics(data as any)
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to load diagnostics")
    } finally {
      setLoadingDiagnostics(false)
    }
  }, [connection])

  useEffect(() => {
    if (!connection) return
    void loadDiagnostics()
    void getQBOAccountingSetupAction().then((data) => setSetup(data)).catch(() => setSetup(null))
  }, [connection, loadDiagnostics])

  useEffect(() => {
    const handleOAuthMessage = async (event: MessageEvent<QBOOAuthMessage>) => {
      if (event.origin !== window.location.origin) return
      const payload = event.data
      if (!payload || payload.type !== "arc:qbo-oauth-complete") return

      if (payload.status !== "success") {
        console.error("QBO OAuth flow returned with an error")
        return
      }

      try {
        const updatedConnection = await getQBOConnectionAction()
        onConnectionChange?.(updatedConnection as QBOConnection | null)
      } catch (error) {
        console.error("Failed to refresh QuickBooks connection after OAuth callback", error)
      }
    }

    window.addEventListener("message", handleOAuthMessage)
    return () => {
      window.removeEventListener("message", handleOAuthMessage)
    }
  }, [onConnectionChange])

  const handleSettingChange = (key: keyof typeof settings, value: boolean | string) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
    startUpdate(async () => {
      try {
        await updateQBOSettingsAction({ [key]: value })
      } catch (err) {
        console.error("Failed to update QBO setting", err)
      }
    })
  }

  const handleRefreshToken = () => {
    startTokenRefresh(async () => {
      try {
        await refreshQBOTokenAction()
        await loadDiagnostics()
        window.location.reload()
      } catch (error) {
        setError(error instanceof Error ? error.message : "Failed to refresh token")
      }
    })
  }

  const handleRetryFailed = () => {
    startRetryFailed(async () => {
      try {
        await retryFailedQBOJobsAction()
        await loadDiagnostics()
      } catch (error) {
        setError(error instanceof Error ? error.message : "Failed to retry failed sync jobs")
      }
    })
  }

  const hasErrors = Boolean(connection?.last_error || diagnostics?.connection?.last_error || error)
  return (
    <Card className="overflow-hidden rounded-none border-0 py-0 shadow-none">
      <CardContent className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex size-12 shrink-0 items-center justify-center border border-border/70 bg-background p-1.5">
              <img src="/qbo.svg" alt="" className="size-9 object-contain" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-sm font-semibold">QuickBooks Online</h3>
                <Badge variant={connection?.status === "active" ? "default" : connection ? "destructive" : "outline"} className="gap-1">
                  {connection?.status === "active" ? <CheckCircle2 className="size-3" /> : <AlertCircle className="size-3" />}
                  {connection ? (connection.status === "active" ? "Connected" : connection.status) : "Not connected"}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">Sync invoices, payments, and numbering with QuickBooks.</p>
              {connection && (
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                  <span>Company: {connection.company_name ?? "QuickBooks Online"}</span>
                  <span>Last sync: {connection.last_sync_at ? new Date(connection.last_sync_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Never"}</span>
                  {expiresInLabel && <span>Access refresh: {expiresInLabel}</span>}
                </div>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 md:justify-end">
            {!connection ? (
              <Button onClick={handleConnect} disabled={isConnecting} size="sm">
                {isConnecting ? (
                  <>
                    <RefreshCw className="mr-1 size-3.5 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  <>
                    Connect
                  </>
                )}
              </Button>
            ) : (
              <>
                <Button variant="outline" size="sm" asChild>
                  <a href="https://qbo.intuit.com/app/homepage" target="_blank" rel="noopener noreferrer">
                    Open QBO
                    <ExternalLink className="ml-1 size-3.5" />
                  </a>
                </Button>
                <Button variant="ghost" size="sm" onClick={handleConnect} disabled={isConnecting}>
                  Reconnect
                </Button>
                <Button variant="ghost" size="sm" onClick={handleDisconnect} disabled={isDisconnecting} className="text-destructive hover:text-destructive">
                  Disconnect
                </Button>
              </>
            )}
          </div>
        </div>

        {!connection ? (
          null
        ) : (
          <div className="flex flex-col gap-4 border-t border-border/60 pt-4">
            {hasErrors && (
              <div className="border border-destructive/20 bg-destructive/[0.03] p-3">
                <div className="flex items-start gap-3">
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div className="flex-1">
                    <h5 className="text-sm font-semibold text-destructive">Sync issue detected</h5>
                    <p className="mt-1 text-sm text-destructive/80">
                      {error ?? diagnostics?.connection?.last_error ?? connection.last_error}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <Button variant="outline" size="sm" onClick={handleRetryFailed} disabled={isRetryingFailed}>
                        Retry Sync
                      </Button>
                      <Button variant="ghost" size="sm" onClick={handleRefreshToken} disabled={isRefreshingToken}>
                        Refresh Connection
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="grid gap-0 border border-border/70">
              <div className="flex items-center justify-between gap-4 border-b border-border/60 p-3">
                <div className="min-w-0">
                  <Label htmlFor="auto-sync" className="text-sm font-medium">Auto-sync invoices</Label>
                    <p className="text-xs text-muted-foreground">Automatically push new invoices to QuickBooks</p>
                </div>
                <Switch
                  id="auto-sync"
                  checked={settings.auto_sync}
                  disabled={isUpdatingSettings}
                  onCheckedChange={(v) => handleSettingChange("auto_sync", v)}
                />
              </div>

              <div className="flex items-center justify-between gap-4 border-b border-border/60 p-3">
                <div className="min-w-0">
                  <Label htmlFor="sync-payments" className="text-sm font-medium">Sync payments</Label>
                    <p className="text-xs text-muted-foreground">Record payments in QuickBooks when an invoice is paid</p>
                </div>
                <Switch
                  id="sync-payments"
                  checked={settings.sync_payments}
                  disabled={isUpdatingSettings}
                  onCheckedChange={(v) => handleSettingChange("sync_payments", v)}
                />
              </div>

              <div className="flex items-center justify-between gap-4 p-3">
                <div className="min-w-0">
                  <Label htmlFor="invoice-number-sync" className="text-sm font-medium">QuickBooks numbering</Label>
                    <p className="text-xs text-muted-foreground">New invoices follow your QuickBooks number sequence</p>
                </div>
                <Switch
                  id="invoice-number-sync"
                  checked={settings.invoice_number_sync}
                  disabled={isUpdatingSettings}
                  onCheckedChange={(v) => handleSettingChange("invoice_number_sync", v)}
                />
              </div>
            </div>

            {setup?.connected ? (
              <div className="grid gap-3 border border-border/70 p-3">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Accounting defaults</p>
                  <p className="mt-1 text-xs text-muted-foreground">These defaults keep day-to-day QBO posting clean; users can still override on each invoice or expense.</p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <SetupSelect
                    label="Invoice income"
                    value={settings.default_income_account_id}
                    accounts={setup.incomeAccounts}
                    onChange={(value) => handleSettingChange("default_income_account_id", value)}
                  />
                  <SetupSelect
                    label="Expense category fallback"
                    value={settings.default_expense_account_id}
                    accounts={setup.expenseAccounts}
                    onChange={(value) => handleSettingChange("default_expense_account_id", value)}
                  />
                  <SetupSelect
                    label="Default paid-from account"
                    value={settings.default_payment_account_id}
                    accounts={setup.paymentAccounts}
                    onChange={(value) => handleSettingChange("default_payment_account_id", value)}
                  />
                  <SetupSelect
                    label="Company card account"
                    value={settings.default_credit_card_account_id}
                    accounts={setup.paymentAccounts.filter((account) => String((account as any).accountType ?? "").toLowerCase() === "credit card")}
                    onChange={(value) => handleSettingChange("default_credit_card_account_id", value)}
                  />
                  <SetupSelect
                    label="Accounts payable"
                    value={settings.default_ap_account_id}
                    accounts={setup.apAccounts}
                    onChange={(value) => handleSettingChange("default_ap_account_id", value)}
                  />
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Project mapping</Label>
                    <Select value={settings.project_mapping_mode} onValueChange={(value) => handleSettingChange("project_mapping_mode", value)}>
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="customer">Arc project as QBO customer/job</SelectItem>
                        <SelectItem value="sub_customer">Client &gt; project sub-customer</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            ) : null}

            <Button variant="ghost" size="sm" onClick={() => setShowAdvanced(!showAdvanced)} className="w-fit px-0 text-xs text-muted-foreground">
              {showAdvanced ? "Hide diagnostics" : "Diagnostics"}
            </Button>

            {showAdvanced && (
              <div className="flex flex-col gap-3 border border-border/70 bg-muted/20 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground">Technical health</p>
                  <Button variant="ghost" size="sm" onClick={loadDiagnostics} disabled={loadingDiagnostics} className="h-7">
                    {loadingDiagnostics ? "Refreshing..." : "Refresh Stats"}
                  </Button>
                </div>
                
                <div className="grid grid-cols-3 gap-3">
                  <div className="border border-border/60 bg-background p-3">
                    <p className="text-xs text-muted-foreground">Pending</p>
                    <p className="mt-1 text-lg font-semibold tabular-nums leading-none">{diagnostics?.outbox?.pending_or_processing ?? 0}</p>
                  </div>
                  <div className="border border-border/60 bg-background p-3">
                    <p className="text-xs text-muted-foreground">Failed jobs</p>
                    <p className={cn("mt-1 text-lg font-semibold tabular-nums leading-none", (diagnostics?.outbox?.failed ?? 0) > 0 ? "text-destructive" : "")}>
                      {diagnostics?.outbox?.failed ?? 0}
                    </p>
                  </div>
                  <div className="border border-border/60 bg-background p-3">
                    <p className="text-xs text-muted-foreground">Invoice errors</p>
                    <p className={cn("mt-1 text-lg font-semibold tabular-nums leading-none", (diagnostics?.invoices?.failed_sync_count ?? 0) > 0 ? "text-destructive" : "")}>
                      {diagnostics?.invoices?.failed_sync_count ?? 0}
                    </p>
                  </div>
                </div>

                {diagnostics?.outbox?.recent_failures?.length ? (
                  <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
                    {diagnostics.outbox.recent_failures.slice(0, 2).map((failure, idx) => (
                      <div key={`${failure.job_type}-${idx}`} className="text-[10px] leading-relaxed">
                        <span className="font-bold text-foreground uppercase">{failure.job_type}</span>
                        <p className="text-muted-foreground italic truncate">{failure.last_error ?? "Unknown error"}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="border border-destructive/20 bg-destructive/[0.03] p-3 text-xs text-destructive">
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SetupSelect({
  label,
  value,
  accounts,
  onChange,
}: {
  label: string
  value: string
  accounts: Array<{ id: string; name: string; fullyQualifiedName?: string }>
  onChange: (value: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value || "none"} onValueChange={(next) => onChange(next === "none" ? "" : next)}>
        <SelectTrigger className="h-9">
          <SelectValue placeholder="Choose account" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Not set</SelectItem>
          {accounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              {account.fullyQualifiedName ?? account.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
