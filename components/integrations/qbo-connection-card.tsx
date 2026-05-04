'use client'

import { useCallback, useEffect, useState, useTransition } from "react"
import { AlertCircle, CheckCircle2, ExternalLink, RefreshCw, Users } from "lucide-react"

import {
  connectQBOAction,
  disconnectQBOAction,
  getQBOConnectionAction,
  getQBODiagnosticsAction,
  refreshQBOTokenAction,
  retryFailedQBOJobsAction,
  updateQBOSettingsAction,
} from "@/app/(app)/settings/integrations/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
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
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(false)
  const [settings, setSettings] = useState(() => ({
    auto_sync: connection?.settings?.auto_sync ?? true,
    sync_payments: connection?.settings?.sync_payments ?? true,
    invoice_number_sync: connection?.settings?.invoice_number_sync ?? true,
  }))

  useEffect(() => {
    setSettings({
      auto_sync: connection?.settings?.auto_sync ?? true,
      sync_payments: connection?.settings?.sync_payments ?? true,
      invoice_number_sync: connection?.settings?.invoice_number_sync ?? true,
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

  const handleSettingChange = (key: keyof typeof settings, value: boolean) => {
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
  const failedCount = (diagnostics?.outbox?.failed ?? 0) + (diagnostics?.invoices?.failed_sync_count ?? 0)

  return (
    <Card className="overflow-hidden border-border/80 shadow-sm transition-all hover:border-border/100 hover:shadow-md">
      <div className="h-2 bg-[#2CA01C]" />
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#2CA01C] text-white shadow-sm">
              <svg viewBox="0 0 40 40" className="h-7 w-7 fill-current">
                <path d="M34 10h-28v20h28v-20zm-2 18h-24v-16h24v16zM10 14h4v2h-4v-2zm0 4h10v2h-10v-2zm0 4h14v2h-14v-2z" opacity=".2"/>
                <rect x="6" y="10" width="28" height="20" rx="2" fill="none" stroke="currentColor" strokeWidth="2.5"/>
              </svg>
            </div>
            <div>
              <CardTitle className="text-xl">QuickBooks Online</CardTitle>
              <CardDescription className="text-sm">Sync invoices and payments automatically</CardDescription>
            </div>
          </div>
          {connection && (
            <Badge 
              variant={connection.status === "active" ? "default" : "destructive"}
              className={cn(
                "px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider",
                connection.status === "active" ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 hover:bg-emerald-500/20" : ""
              )}
            >
              {connection.status === "active" ? (
                <>
                  <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                  Connected
                </>
              ) : (
                <>
                  <AlertCircle className="mr-1.5 h-3.5 w-3.5" />
                  {connection.status}
                </>
              )}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {!connection ? (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-border/50 bg-muted/30 p-4 transition-colors hover:bg-muted/50">
                <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-[#2CA01C]/10 text-[#2CA01C]">
                  <RefreshCw className="h-4 w-4" />
                </div>
                <h4 className="text-sm font-semibold">Automatic Sync</h4>
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                  Invoices and payments sync to QuickBooks in real-time.
                </p>
              </div>
              <div className="rounded-xl border border-border/50 bg-muted/30 p-4 transition-colors hover:bg-muted/50">
                <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-[#2CA01C]/10 text-[#2CA01C]">
                  <Users className="h-4 w-4" />
                </div>
                <h4 className="text-sm font-semibold">Contact Mapping</h4>
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                  Customers and vendors are automatically matched or created.
                </p>
              </div>
            </div>

            <Button onClick={handleConnect} disabled={isConnecting} className="h-11 w-full font-medium bg-[#2CA01C] hover:bg-[#238217]">
              {isConnecting ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Connect QuickBooks
                </>
              )}
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.03] p-5">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase tracking-wider text-emerald-600/80">Connected Company</p>
                  <p className="text-base font-semibold text-foreground">{connection.company_name ?? "QuickBooks Online"}</p>
                </div>
                <Button variant="ghost" size="sm" asChild className="text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-700">
                  <a href="https://qbo.intuit.com/app/homepage" target="_blank" rel="noopener noreferrer">
                    Open QBO <ExternalLink className="ml-2 h-3.5 w-3.5" />
                  </a>
                </Button>
              </div>
              
              <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-emerald-500/10 pt-4">
                <div className="space-y-0.5">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70">Last Sync</p>
                  <p className="text-xs font-medium">{connection.last_sync_at ? new Date(connection.last_sync_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : "Never"}</p>
                </div>
                {expiresInLabel && (
                  <div className="space-y-0.5">
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70">Access Refresh</p>
                    <p className="text-xs font-medium">{expiresInLabel}</p>
                  </div>
                )}
              </div>
            </div>

            {hasErrors && (
              <div className="rounded-xl border border-destructive/20 bg-destructive/[0.03] p-5">
                <div className="flex items-start gap-3">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div className="flex-1">
                    <h5 className="text-sm font-semibold text-destructive">Sync Issue Detected</h5>
                    <p className="mt-1 text-sm text-destructive/80 leading-relaxed">
                      {error ?? diagnostics?.connection?.last_error ?? connection.last_error}
                    </p>
                    <div className="mt-4 flex gap-3">
                      <Button variant="outline" size="sm" onClick={handleRetryFailed} disabled={isRetryingFailed} className="border-destructive/20 text-destructive hover:bg-destructive/10">
                        Retry Sync
                      </Button>
                      <Button variant="ghost" size="sm" onClick={handleRefreshToken} disabled={isRefreshingToken} className="text-destructive/70 hover:text-destructive">
                        Refresh Connection
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-4 pt-2">
              <h5 className="text-xs font-bold uppercase tracking-[0.15em] text-muted-foreground/60">Sync Settings</h5>
              <div className="grid gap-4 rounded-xl border border-border/50 bg-muted/20 p-5">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label htmlFor="auto-sync" className="text-sm font-semibold">Auto-sync Invoices</Label>
                    <p className="text-xs text-muted-foreground">Automatically push new invoices to QuickBooks</p>
                  </div>
                  <Switch
                    id="auto-sync"
                    checked={settings.auto_sync}
                    disabled={isUpdatingSettings}
                    onCheckedChange={(v) => handleSettingChange("auto_sync", v)}
                  />
                </div>

                <div className="flex items-center justify-between border-t border-border/40 pt-4">
                  <div className="space-y-1">
                    <Label htmlFor="sync-payments" className="text-sm font-semibold">Sync Payments</Label>
                    <p className="text-xs text-muted-foreground">Record payments in QuickBooks when an invoice is paid</p>
                  </div>
                  <Switch
                    id="sync-payments"
                    checked={settings.sync_payments}
                    disabled={isUpdatingSettings}
                    onCheckedChange={(v) => handleSettingChange("sync_payments", v)}
                  />
                </div>

                <div className="flex items-center justify-between border-t border-border/40 pt-4">
                  <div className="space-y-1">
                    <Label htmlFor="invoice-number-sync" className="text-sm font-semibold">QuickBooks Numbering</Label>
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
            </div>

            <div className="flex items-center justify-between pt-2">
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={handleConnect} disabled={isConnecting} className="text-muted-foreground">
                  Reconnect
                </Button>
                <Button variant="ghost" size="sm" onClick={handleDisconnect} disabled={isDisconnecting} className="text-destructive/60 hover:text-destructive hover:bg-destructive/5">
                  Disconnect
                </Button>
              </div>
              
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="text-[10px] uppercase tracking-widest text-muted-foreground/60 hover:text-muted-foreground"
              >
                {showAdvanced ? "Hide Diagnostics" : "Diagnostics"}
              </Button>
            </div>

            {showAdvanced && (
              <div className="mt-4 space-y-4 rounded-xl border border-border/50 bg-muted/40 p-5">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Technical Health</p>
                  <Button variant="ghost" size="sm" onClick={loadDiagnostics} disabled={loadingDiagnostics} className="h-6 text-[10px]">
                    {loadingDiagnostics ? "Refreshing..." : "Refresh Stats"}
                  </Button>
                </div>
                
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-lg bg-background/50 p-3 border border-border/40">
                    <p className="text-[9px] uppercase tracking-widest text-muted-foreground">Pending</p>
                    <p className="mt-1 text-lg font-semibold tabular-nums leading-none">{diagnostics?.outbox?.pending_or_processing ?? 0}</p>
                  </div>
                  <div className="rounded-lg bg-background/50 p-3 border border-border/40">
                    <p className="text-[9px] uppercase tracking-widest text-muted-foreground">Failed Jobs</p>
                    <p className={cn("mt-1 text-lg font-semibold tabular-nums leading-none", (diagnostics?.outbox?.failed ?? 0) > 0 ? "text-destructive" : "")}>
                      {diagnostics?.outbox?.failed ?? 0}
                    </p>
                  </div>
                  <div className="rounded-lg bg-background/50 p-3 border border-border/40">
                    <p className="text-[9px] uppercase tracking-widest text-muted-foreground">Inv Errors</p>
                    <p className={cn("mt-1 text-lg font-semibold tabular-nums leading-none", (diagnostics?.invoices?.failed_sync_count ?? 0) > 0 ? "text-destructive" : "")}>
                      {diagnostics?.invoices?.failed_sync_count ?? 0}
                    </p>
                  </div>
                </div>

                {diagnostics?.outbox?.recent_failures?.length ? (
                  <div className="space-y-2 border-t border-border/40 pt-3">
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
          <div className="rounded-lg border border-destructive/20 bg-destructive/[0.03] p-3 text-xs text-destructive">
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

