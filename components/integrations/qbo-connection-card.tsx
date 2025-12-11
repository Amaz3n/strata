'use client'

import { useState, useTransition } from "react"
import { AlertCircle, CheckCircle2, ExternalLink, RefreshCw } from "lucide-react"

import { connectQBOAction, disconnectQBOAction, updateQBOSettingsAction } from "@/app/settings/integrations/actions"
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
