"use client"

import { useEffect, useState } from "react"
import { format, formatDistanceToNow } from "date-fns"
import { toast } from "sonner"

import type { PortalAccessToken } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import {
  ChevronDown,
  Copy,
  ExternalLink,
  Trash2 as Trash,
  User,
  Users,
  Clock,
  Lock,
  ShieldCheck,
  CheckCircle2,
  Ban,
  Eye,
} from "@/components/icons"

interface AccessTokenListProps {
  projectId: string
  tokens: PortalAccessToken[]
  onRevoke: (tokenId: string) => Promise<void> | void
  isLoading?: boolean
  onSetPin?: (tokenId: string, pin: string) => Promise<void> | void
  onClearPin?: (tokenId: string) => Promise<void> | void
}

export function AccessTokenList({ tokens, onRevoke, isLoading, onSetPin, onClearPin }: AccessTokenListProps) {
  const fallbackOrigin = process.env.NEXT_PUBLIC_APP_URL || ""
  const [origin, setOrigin] = useState(fallbackOrigin)

  useEffect(() => {
    if (typeof window === "undefined") return
    setOrigin(window.location.origin)
  }, [])

  const handleCopy = async (token: PortalAccessToken) => {
    const url = `${origin}/${token.portal_type === "client" ? "p" : "s"}/${token.token}`

    // Try modern clipboard API first
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(url)
        toast.success("Link copied")
        return
      } catch {
        // Fall through to fallback
      }
    }

    // Fallback for iOS and older browsers
    try {
      const textArea = document.createElement("textarea")
      textArea.value = url
      textArea.style.position = "fixed"
      textArea.style.left = "-9999px"
      textArea.style.top = "0"
      document.body.appendChild(textArea)
      textArea.focus()
      textArea.select()

      const successful = document.execCommand("copy")
      document.body.removeChild(textArea)

      if (successful) {
        toast.success("Link copied")
      } else {
        toast.error("Unable to copy link")
      }
    } catch {
      toast.error("Unable to copy link")
    }
  }

  return (
    <div className="space-y-3">
      {tokens.length === 0 && (
        <div className="flex flex-col items-center justify-center border border-dashed border-muted-foreground/20 bg-muted/20 px-4 py-8 text-center">
          <div className="mb-2 flex h-10 w-10 items-center justify-center bg-muted">
            <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground">No active links</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Create a link above to share access
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
  const [detailsOpen, setDetailsOpen] = useState(false)

  const isRevoked = !!token.revoked_at
  const isExpired = token.expires_at && new Date(token.expires_at) < new Date()
  const isActive = !isRevoked && !isExpired

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

  const PortalIcon = token.portal_type === "client" ? User : Users

  return (
    <div
      className={cn(
        "border bg-card overflow-hidden",
        isActive ? "" : "opacity-60"
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 p-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <div
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center",
              isActive
                ? token.portal_type === "client"
                  ? "bg-primary/10 text-primary"
                  : "bg-chart-2/10 text-chart-2"
                : "bg-muted text-muted-foreground"
            )}
          >
            <PortalIcon className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-medium capitalize">{token.portal_type}</span>
              {isActive ? (
                <Badge variant="secondary" className="gap-1 bg-success/10 text-success text-[10px] px-1.5 py-0">
                  Active
                </Badge>
              ) : isRevoked ? (
                <Badge variant="secondary" className="gap-1 bg-destructive/10 text-destructive text-[10px] px-1.5 py-0">
                  Revoked
                </Badge>
              ) : (
                <Badge variant="secondary" className="gap-1 bg-warning/10 text-warning text-[10px] px-1.5 py-0">
                  Expired
                </Badge>
              )}
              {token.pin_required && (
                <Lock className="h-3 w-3 text-primary" />
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>{format(new Date(token.created_at), "MMM d")}</span>
              {token.expires_at && (
                <span>
                  {isExpired ? "Expired" : "Exp"} {format(new Date(token.expires_at), "MMM d")}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          {isActive && (
            <Button size="sm" variant="ghost" onClick={onCopy} className="h-7 px-2 text-xs">
              <Copy className="h-3 w-3" />
            </Button>
          )}
          {isActive && (
            <Button
              size="icon"
              variant="ghost"
              disabled={isLoading}
              onClick={() => onRevoke(token.id)}
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
            >
              <Trash className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* URL Preview - Fixed width with truncation */}
      {isActive && (
        <div className="mx-3 mb-2 flex items-center gap-2 border bg-muted/30 px-2 py-1.5 overflow-hidden">
          <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            .../{token.portal_type === "client" ? "p" : "s"}/{token.token.slice(0, 8)}...
          </span>
          <Button size="sm" variant="ghost" onClick={onCopy} className="h-5 px-1.5 text-[10px] shrink-0 ml-auto">
            Copy
          </Button>
        </div>
      )}

      {/* Last Accessed */}
      <div className="border-t bg-muted/20 px-3 py-1.5">
        <span className="text-[11px] text-muted-foreground">
          <Eye className="mr-1 inline h-3 w-3" />
          {token.last_accessed_at
            ? `Opened ${formatDistanceToNow(new Date(token.last_accessed_at), { addSuffix: true })}`
            : "Not opened yet"}
        </span>
      </div>

      {/* Details Expander */}
      <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-center gap-1 border-t py-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
          >
            <span>{detailsOpen ? "Hide" : "Details"}</span>
            <ChevronDown
              className={cn("h-3 w-3 transition-transform duration-200", detailsOpen && "rotate-180")}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3 border-t bg-muted/10 p-3">
            {/* PIN Management */}
            {isActive && (onSetPin || onClearPin) && (
              <div className="border bg-background p-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Lock
                      className={cn("h-3.5 w-3.5", token.pin_required ? "text-primary" : "text-muted-foreground")}
                    />
                    <span className="text-xs font-medium">
                      {token.pin_required ? "PIN on" : "PIN off"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setPinMode(pinMode === "view" ? "edit" : "view")}
                      className="h-6 px-2 text-[11px]"
                    >
                      {pinMode === "edit" ? "Cancel" : token.pin_required ? "Change" : "Add"}
                    </Button>
                    {token.pin_required && onClearPin && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onClearPin(token.id)}
                        disabled={isLoading}
                        className="h-6 px-2 text-[11px] text-destructive hover:text-destructive"
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
                {pinMode === "edit" && (
                  <div className="mt-2 flex gap-2">
                    <Input
                      type="password"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={6}
                      placeholder="4-6 digits"
                      value={pinInput}
                      onChange={(e) => setPinInput(e.target.value)}
                      className="h-8 font-mono text-xs"
                    />
                    <Button size="sm" onClick={handleSavePin} disabled={isLoading} className="h-8 text-xs">
                      Save
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Permissions Grid */}
            <div className="space-y-1.5">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                Permissions
              </p>
              <div className="grid grid-cols-2 gap-1">
                <PermissionPill label="Schedule" enabled={token.permissions.can_view_schedule} />
                <PermissionPill label="Photos" enabled={token.permissions.can_view_photos} />
                <PermissionPill label="Documents" enabled={token.permissions.can_view_documents} />
                <PermissionPill label="Download" enabled={token.permissions.can_download_files ?? true} />
                <PermissionPill label="Daily logs" enabled={token.permissions.can_view_daily_logs} />
                <PermissionPill label="Budget" enabled={token.permissions.can_view_budget} />
                <PermissionPill label="Invoices" enabled={token.permissions.can_view_invoices ?? true} />
                <PermissionPill label="Pay" enabled={token.permissions.can_pay_invoices ?? false} />
                <PermissionPill label="RFIs" enabled={token.permissions.can_view_rfis ?? true} />
                <PermissionPill label="Respond RFIs" enabled={token.permissions.can_respond_rfis ?? true} />
                <PermissionPill label="Submittals" enabled={token.permissions.can_view_submittals ?? true} />
                <PermissionPill label="Submit" enabled={token.permissions.can_submit_submittals ?? true} />
                <PermissionPill label="Change orders" enabled={token.permissions.can_approve_change_orders} />
                <PermissionPill label="Selections" enabled={token.permissions.can_submit_selections} />
                <PermissionPill label="Punch" enabled={token.permissions.can_create_punch_items} />
                <PermissionPill label="Messages" enabled={token.permissions.can_message} />
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function PermissionPill({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 px-1.5 py-1 text-[10px]",
        enabled ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"
      )}
    >
      <div
        className={cn("h-1 w-1 rounded-full", enabled ? "bg-success" : "bg-muted-foreground/50")}
      />
      <span className="truncate">{label}</span>
    </div>
  )
}
