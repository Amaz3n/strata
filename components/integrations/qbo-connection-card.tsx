'use client'

import { useCallback, useEffect, useState, useTransition } from "react"
import { AlertCircle, CheckCircle2, ExternalLink, RefreshCw } from "lucide-react"

import {
  connectQBOAction,
  disconnectQBOAction,
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

interface Props {
  connection: QBOConnection | null
}

export function QBOConnectionCard({ connection }: Props) {
  const [isConnecting, setIsConnecting] = useState(false)
  const [isDisconnecting, startDisconnect] = useTransition()
  const [isUpdatingSettings, startUpdate] = useTransition()
  const [isRefreshingToken, startTokenRefresh] = useTransition()
  const [isRetryingFailed, startRetryFailed] = useTransition()
  const [diagnostics, setDiagnostics] = useState<{
    outbox?: { pending_or_processing?: number; failed?: number; recent_failures?: Array<{ job_type: string; last_error: string | null; updated_at: string | null }> }
    invoices?: { failed_sync_count?: number }
    connection?: { last_error?: string | null } | null
  } | null>(null)
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null)
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(false)
  const [settings, setSettings] = useState(() => ({
    auto_sync: connection?.settings?.auto_sync ?? true,
    sync_payments: connection?.settings?.sync_payments ?? true,
    invoice_number_sync: connection?.settings?.invoice_number_sync ?? true,
  }))

  const expiresInLabel = (() => {
    if (!connection?.token_expires_at) return null
    const expires = new Date(connection.token_expires_at).getTime()
    const diffHours = Math.round((expires - Date.now()) / (1000 * 60 * 60))
    if (diffHours < 0) return "Token expired"
    if (diffHours < 24) return `Token expires in ${diffHours}h`
    const days = Math.ceil(diffHours / 24)
    return `Token expires in ${days}d`
  })()

  const handleConnect = async () => {
    setIsConnecting(true)
    try {
      const result = await connectQBOAction()
      if (result?.authUrl) {
        if (result.state) {
          // Ensure the state cookie is present even if the server-set cookie is dropped by the browser.
          const secure = window.location.protocol === "https:"
          document.cookie = [
            `qbo_oauth_state=${result.state}`,
            "Path=/",
            "SameSite=Lax",
            "Max-Age=600",
            secure ? "Secure" : "",
          ]
            .filter(Boolean)
            .join(";")
        }
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
    setDiagnosticsError(null)
    try {
      const data = await getQBODiagnosticsAction()
      setDiagnostics(data as any)
    } catch (error) {
      setDiagnosticsError(error instanceof Error ? error.message : "Failed to load diagnostics")
    } finally {
      setLoadingDiagnostics(false)
    }
  }, [connection])

  useEffect(() => {
    if (!connection) return
    void loadDiagnostics()
  }, [connection, loadDiagnostics])

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
        setDiagnosticsError(error instanceof Error ? error.message : "Failed to refresh token")
      }
    })
  }

  const handleRetryFailed = () => {
    startRetryFailed(async () => {
      try {
        await retryFailedQBOJobsAction()
        await loadDiagnostics()
      } catch (error) {
        setDiagnosticsError(error instanceof Error ? error.message : "Failed to retry failed sync jobs")
      }
    })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#2CA01C] rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">QB</span>
            </div>
            <div>
              <CardTitle className="text-lg">QuickBooks Online</CardTitle>
              <CardDescription>Sync invoices and payments automatically</CardDescription>
            </div>
          </div>
          {connection && (
            <Badge variant={connection.status === "active" ? "default" : "destructive"}>
              {connection.status === "active" ? (
                <>
                  <CheckCircle2 className="w-3 h-3 mr-1" />
                  Connected
                </>
              ) : (
                <>
                  <AlertCircle className="w-3 h-3 mr-1" />
                  {connection.status}
                </>
              )}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {!connection ? (
          <div className="space-y-4">
            <div className="bg-muted/50 rounded-lg p-4 space-y-2">
              <h4 className="font-medium">What gets synced:</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Invoice numbers follow your QBO sequence</li>
                <li>• Invoices → QBO Invoices (automatic)</li>
                <li>• Payments → QBO Payments (automatic)</li>
                <li>• Customers → QBO Customers (auto-created)</li>
              </ul>
            </div>

            <Button onClick={handleConnect} disabled={isConnecting} className="w-full">
              {isConnecting ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <ExternalLink className="w-4 h-4 mr-2" />
                  Connect QuickBooks
                </>
              )}
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Connected to:</span>
              <span className="font-medium">{connection.company_name ?? "QuickBooks"}</span>
            </div>

            {connection.last_sync_at && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Last sync:</span>
                <span>{new Date(connection.last_sync_at).toLocaleString()}</span>
              </div>
            )}

            {expiresInLabel && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Connection health:</span>
                <span className="font-medium">{expiresInLabel}</span>
              </div>
            )}

            {(connection.last_error || diagnostics?.connection?.last_error || diagnosticsError) && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive space-y-1">
                <div className="font-medium">Connection issue detected</div>
                <div>{diagnosticsError ?? diagnostics?.connection?.last_error ?? connection.last_error}</div>
              </div>
            )}

            {connection && (
              <div className="rounded-md border p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Sync diagnostics</p>
                  <Button variant="ghost" size="sm" onClick={loadDiagnostics} disabled={loadingDiagnostics}>
                    {loadingDiagnostics ? "Refreshing..." : "Refresh"}
                  </Button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                  <div className="rounded bg-muted/50 p-2">
                    <div className="text-muted-foreground">Queue pending</div>
                    <div className="text-sm font-semibold">{diagnostics?.outbox?.pending_or_processing ?? 0}</div>
                  </div>
                  <div className="rounded bg-muted/50 p-2">
                    <div className="text-muted-foreground">Queue failed</div>
                    <div className="text-sm font-semibold">{diagnostics?.outbox?.failed ?? 0}</div>
                  </div>
                  <div className="rounded bg-muted/50 p-2">
                    <div className="text-muted-foreground">Invoices failed</div>
                    <div className="text-sm font-semibold">{diagnostics?.invoices?.failed_sync_count ?? 0}</div>
                  </div>
                </div>
                {diagnostics?.outbox?.recent_failures?.length ? (
                  <div className="space-y-1">
                    {diagnostics.outbox.recent_failures.slice(0, 2).map((failure, idx) => (
                      <div key={`${failure.job_type}-${idx}`} className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{failure.job_type}</span>: {failure.last_error ?? "Unknown error"}
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={handleRefreshToken} disabled={isRefreshingToken}>
                    {isRefreshingToken ? "Refreshing token..." : "Refresh token"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleRetryFailed} disabled={isRetryingFailed}>
                    {isRetryingFailed ? "Retrying..." : "Retry failed syncs"}
                  </Button>
                </div>
              </div>
            )}

            <div className="border-t pt-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="auto-sync">Auto-sync invoices</Label>
                  <p className="text-xs text-muted-foreground">New invoices sync within 5 minutes</p>
                </div>
                <Switch
                  id="auto-sync"
                  checked={settings.auto_sync}
                  disabled={isUpdatingSettings}
                  onCheckedChange={(v) => handleSettingChange("auto_sync", v)}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="sync-payments">Sync payments</Label>
                  <p className="text-xs text-muted-foreground">Record payments in QBO when paid</p>
                </div>
                <Switch
                  id="sync-payments"
                  checked={settings.sync_payments}
                  disabled={isUpdatingSettings}
                  onCheckedChange={(v) => handleSettingChange("sync_payments", v)}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="invoice-number-sync">Sync invoice numbers</Label>
                  <p className="text-xs text-muted-foreground">New invoices will follow QuickBooks numbering</p>
                </div>
                <Switch
                  id="invoice-number-sync"
                  checked={settings.invoice_number_sync}
                  disabled={isUpdatingSettings}
                  onCheckedChange={(v) => handleSettingChange("invoice_number_sync", v)}
                />
              </div>
            </div>

            <div className="border-t pt-4 flex justify-between items-center">
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={handleDisconnect} disabled={isDisconnecting}>
                  {isDisconnecting ? (
                    <>
                      <RefreshCw className="w-3 h-3 mr-2 animate-spin" />
                      Disconnecting...
                    </>
                  ) : (
                    "Disconnect"
                  )}
                </Button>
                <Button variant="ghost" size="sm" onClick={handleConnect} disabled={isConnecting}>
                  {isConnecting ? "Reconnecting..." : "Reconnect"}
                </Button>
              </div>
              <Button variant="outline" size="sm" asChild>
                <a href="https://qbo.intuit.com/app/homepage" target="_blank" rel="noopener noreferrer">
                  Open QuickBooks <ExternalLink className="w-3 h-3 ml-1" />
                </a>
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
