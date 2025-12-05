"use client"

import type { PortalPermissions } from "@/lib/types"
import { Switch } from "@/components/ui/switch"

interface PermissionTogglesProps {
  value: Partial<PortalPermissions>
  onChange: (value: Partial<PortalPermissions>) => void
}

const DEFAULTS: PortalPermissions = {
  can_view_schedule: true,
  can_view_photos: true,
  can_view_documents: true,
  can_download_files: true,
  can_view_daily_logs: false,
  can_view_budget: false,
  can_view_invoices: true,
  can_pay_invoices: false,
  can_view_rfis: true,
  can_respond_rfis: true,
  can_view_submittals: true,
  can_submit_submittals: true,
  can_approve_change_orders: true,
  can_submit_selections: true,
  can_create_punch_items: false,
  can_message: true,
}

export function PermissionToggles({ value, onChange }: PermissionTogglesProps) {
  const merged = { ...DEFAULTS, ...value }

  const update = (key: keyof PortalPermissions, next: boolean) => {
    onChange({ ...merged, [key]: next })
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
      {Object.entries(merged).map(([key, enabled]) => (
        <label key={key} className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          <Switch
            checked={!!enabled}
            onCheckedChange={(checked) => update(key as keyof PortalPermissions, checked)}
            className="data-[state=checked]:bg-primary"
          />
          <span className="text-xs capitalize text-muted-foreground">
            {key.replaceAll("can_", "").replaceAll("_", " ")}
          </span>
        </label>
      ))}
    </div>
  )
}

