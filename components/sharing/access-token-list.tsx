"use client"

import { useMemo } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { PortalAccessToken } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Copy, ExternalLink, Trash2 as Trash } from "@/components/icons"

interface AccessTokenListProps {
  projectId: string
  tokens: PortalAccessToken[]
  onRevoke: (tokenId: string) => Promise<void> | void
  isLoading?: boolean
}

export function AccessTokenList({ tokens, onRevoke, isLoading }: AccessTokenListProps) {
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
      {tokens.length === 0 && <p className="text-sm text-muted-foreground">No access links yet.</p>}
      {tokens.map((token) => (
        <div key={token.id} className="rounded-lg border bg-card/50 p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge variant={token.portal_type === "client" ? "default" : "secondary"} className="capitalize">
                {token.portal_type}
              </Badge>
              <Badge variant={token.revoked_at ? "outline" : "secondary"}>
                {token.revoked_at ? "Revoked" : "Active"}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              {!token.revoked_at && (
                <Button size="icon" variant="ghost" onClick={() => handleCopy(token)}>
                  <Copy className="h-4 w-4" />
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
          <div className="text-xs text-muted-foreground space-y-1">
            <p>Created {format(new Date(token.created_at), "MMM d, yyyy")}</p>
            {token.expires_at && <p>Expires {format(new Date(token.expires_at), "MMM d, yyyy")}</p>}
            {token.last_accessed_at && <p>Last accessed {format(new Date(token.last_accessed_at), "MMM d, yyyy p")}</p>}
          </div>
          <Separator />
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 text-xs">
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
          {!token.revoked_at && (
            <div className="flex items-center gap-2 text-xs">
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="truncate">
                {origin}/{token.portal_type === "client" ? "p" : "s"}/{token.token}
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function PermissionFlag({ label, value }: { label: string; value: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1">
      <Switch checked={value} disabled className="data-[state=checked]:bg-primary" />
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  )
}

