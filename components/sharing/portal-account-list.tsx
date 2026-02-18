"use client"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import type { ExternalPortalAccount } from "@/lib/types"

interface PortalAccountListProps {
  accounts: ExternalPortalAccount[]
  isLoading?: boolean
  onSetStatus: (accountId: string, status: "active" | "paused" | "revoked") => Promise<void> | void
}

export function PortalAccountList({ accounts, isLoading, onSetStatus }: PortalAccountListProps) {
  if (accounts.length === 0) {
    return <p className="text-xs text-muted-foreground">No claimed accounts yet.</p>
  }

  return (
    <div className="space-y-2">
      {accounts.map((account) => (
        <div key={account.id} className="border bg-card p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{account.full_name || account.email}</p>
              <p className="text-xs text-muted-foreground truncate">{account.email}</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Grants: {account.grant_count ?? 0}
              </p>
            </div>
            <Badge
              variant="outline"
              className={
                account.status === "active"
                  ? "text-emerald-700 border-emerald-200"
                  : account.status === "paused"
                    ? "text-amber-700 border-amber-200"
                    : "text-rose-700 border-rose-200"
              }
            >
              {account.status}
            </Badge>
          </div>
          <div className="flex items-center gap-1 mt-2">
            {account.status !== "active" && (
              <Button
                size="sm"
                variant="outline"
                disabled={isLoading}
                onClick={() => onSetStatus(account.id, "active")}
                className="h-7 text-xs"
              >
                Resume
              </Button>
            )}
            {account.status === "active" && (
              <Button
                size="sm"
                variant="outline"
                disabled={isLoading}
                onClick={() => onSetStatus(account.id, "paused")}
                className="h-7 text-xs"
              >
                Pause
              </Button>
            )}
            {account.status !== "revoked" && (
              <Button
                size="sm"
                variant="ghost"
                disabled={isLoading}
                onClick={() => onSetStatus(account.id, "revoked")}
                className="h-7 text-xs text-destructive hover:text-destructive"
              >
                Revoke
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
