"use client"

import { useMemo, useState } from "react"
import { format, formatDistanceToNow } from "date-fns"
import { toast } from "sonner"

import type { PortalAccessToken } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Copy, ExternalLink, Trash2 as Trash } from "@/components/icons"

interface AccessTokenListProps {
  projectId: string
  tokens: PortalAccessToken[]
  onRevoke: (tokenId: string) => Promise<void> | void
  isLoading?: boolean
  onSetPin?: (tokenId: string, pin: string) => Promise<void> | void
  onClearPin?: (tokenId: string) => Promise<void> | void
}

export function AccessTokenList({ tokens, onRevoke, isLoading, onSetPin, onClearPin }: AccessTokenListProps) {
  const origin = useMemo(() => {
    if (typeof window === "undefined") return ""
    return window.location.origin
  }, [])

  const handleCopy = (token: PortalAccessToken) => {
    const url = `${origin}/${token.portal_type === "client" ? "p" : "s"}/${token.token}`
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success("Link copied"))
      .catch(() => toast.error("Unable to copy link"))
  }

  return (
    <div className="space-y-3">
      {tokens.length === 0 && (
        <div className="rounded-xl border border-dashed bg-muted/30 p-6 text-center">
          <p className="text-sm font-medium">No access links yet</p>
          <p className="text-xs text-muted-foreground">
            Generate a client or subcontractor link to see it listed here.
          </p>
        </div>
      )}
      {tokens.map((token) => (
        <TokenCard
          key={token.id}
          token={token}
          origin={origin}
          onRevoke={onRevoke}
          onSetPin={onSetPin}
          onClearPin={onClearPin}
          isLoading={isLoading}
          onCopy={() => handleCopy(token)}
        />
      ))}
    </div>
  )
}

function TokenCard({
  token,
  origin,
  onCopy,
  onRevoke,
  onSetPin,
  onClearPin,
  isLoading,
}: {
  token: PortalAccessToken
  origin: string
  onCopy: () => void
  onRevoke: (tokenId: string) => Promise<void> | void
  onSetPin?: (tokenId: string, pin: string) => Promise<void> | void
  onClearPin?: (tokenId: string) => Promise<void> | void
  isLoading?: boolean
}) {
  const [pinInput, setPinInput] = useState("")
  const [pinMode, setPinMode] = useState<"view" | "edit">("view")

  const handleSavePin = async () => {
    if (!onSetPin) return
    if (!/^[0-9]{4,6}$/.test(pinInput)) {
      toast.error("Enter a 4-6 digit PIN")
      return
    }
    await onSetPin(token.id, pinInput)
    setPinInput("")
    setPinMode("view")
  }

  return (
    <div className="space-y-3 rounded-xl border bg-card/80 p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={token.portal_type === "client" ? "default" : "secondary"} className="capitalize">
                  {token.portal_type} portal
                </Badge>
                <Badge variant={token.revoked_at ? "outline" : "secondary"}>
                  {token.revoked_at ? "Revoked" : "Active"}
                </Badge>
                <Badge variant={token.pin_required ? "default" : "outline"}>
                  {token.pin_required ? "PIN protected" : "No PIN"}
                </Badge>
                {token.expires_at && (
                  <Badge variant="outline">Expires {format(new Date(token.expires_at), "MMM d, yyyy")}</Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground space-y-1">
                <p>Created {format(new Date(token.created_at), "MMM d, yyyy")}</p>
                <p>
                  Last opened{" "}
                  {token.last_accessed_at
                    ? formatDistanceToNow(new Date(token.last_accessed_at), { addSuffix: true })
                    : "Not yet"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {!token.revoked_at && (
                <Button size="sm" variant="outline" onClick={onCopy}>
                  <Copy className="mr-2 h-4 w-4" />
                  Copy
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                disabled={!!token.revoked_at || isLoading}
                onClick={() => onRevoke(token.id)}
              >
                <Trash className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          </div>
          {!token.revoked_at && (
            <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 truncate">
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="truncate font-mono text-[11px]">
                  {origin}/{token.portal_type === "client" ? "p" : "s"}/{token.token}
                </span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="text-[11px]">Copy & share</span>
                <Button size="sm" variant="ghost" onClick={onCopy}>
                  Copy
                </Button>
              </div>
            </div>
          )}

          {!token.revoked_at && (onSetPin || onClearPin) && (
            <div className="rounded-lg border bg-muted/40 px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant={token.pin_required ? "default" : "outline"}>
                    {token.pin_required ? "PIN enabled" : "PIN optional"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {token.pin_required ? "Change or remove PIN" : "Add a PIN for extra security"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setPinMode(pinMode === "view" ? "edit" : "view")}
                  >
                    {pinMode === "edit" ? "Close" : token.pin_required ? "Change PIN" : "Add PIN"}
                  </Button>
                  {token.pin_required && onClearPin && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onClearPin(token.id)}
                      disabled={isLoading}
                    >
                      Remove PIN
                    </Button>
                  )}
                </div>
              </div>
              {pinMode === "edit" && (
                <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    type="password"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    placeholder="4-6 digits"
                    value={pinInput}
                    onChange={(e) => setPinInput(e.target.value)}
                  />
                  <Button size="sm" onClick={handleSavePin} disabled={isLoading}>
                    Save PIN
                  </Button>
                </div>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-4">
            <PermissionFlag label="Schedule" value={token.permissions.can_view_schedule} />
            <PermissionFlag label="Photos" value={token.permissions.can_view_photos} />
            <PermissionFlag label="Documents" value={token.permissions.can_view_documents} />
            <PermissionFlag label="Download files" value={token.permissions.can_download_files ?? true} />
            <PermissionFlag label="Daily logs" value={token.permissions.can_view_daily_logs} />
            <PermissionFlag label="Budget" value={token.permissions.can_view_budget} />
            <PermissionFlag label="Invoices" value={token.permissions.can_view_invoices ?? true} />
            <PermissionFlag label="Pay invoices" value={token.permissions.can_pay_invoices ?? false} />
            <PermissionFlag label="RFIs" value={token.permissions.can_view_rfis ?? true} />
            <PermissionFlag label="Respond RFIs" value={token.permissions.can_respond_rfis ?? true} />
            <PermissionFlag label="Submittals" value={token.permissions.can_view_submittals ?? true} />
            <PermissionFlag label="Submit submittals" value={token.permissions.can_submit_submittals ?? true} />
            <PermissionFlag label="Change orders" value={token.permissions.can_approve_change_orders} />
            <PermissionFlag label="Selections" value={token.permissions.can_submit_selections} />
            <PermissionFlag label="Punch items" value={token.permissions.can_create_punch_items} />
            <PermissionFlag label="Messaging" value={token.permissions.can_message} />
          </div>
        </div>
  )
}

function PermissionFlag({ label, value }: { label: string; value: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-2 py-1">
      <Switch checked={value} disabled className="data-[state=checked]:bg-primary" />
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  )
}
