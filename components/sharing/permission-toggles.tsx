"use client"

import type { PortalPermissions } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Switch } from "@/components/ui/switch"
import {
  Calendar,
  Camera,
  FileText,
  Download,
  ClipboardList,
  DollarSign,
  Receipt,
  CreditCard,
  MessageSquare,
  CheckSquare,
  Edit,
  Layers,
  Flag,
} from "@/components/icons"

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

const PERMISSION_GROUPS = [
  {
    label: "View",
    permissions: [
      { key: "can_view_schedule", label: "Schedule", icon: Calendar },
      { key: "can_view_photos", label: "Photos", icon: Camera },
      { key: "can_view_documents", label: "Documents", icon: FileText },
      { key: "can_download_files", label: "Download files", icon: Download },
      { key: "can_view_daily_logs", label: "Daily logs", icon: ClipboardList },
      { key: "can_view_budget", label: "Budget", icon: DollarSign },
      { key: "can_view_invoices", label: "Invoices", icon: Receipt },
      { key: "can_view_rfis", label: "RFIs", icon: MessageSquare },
      { key: "can_view_submittals", label: "Submittals", icon: Layers },
    ],
  },
  {
    label: "Actions",
    permissions: [
      { key: "can_pay_invoices", label: "Pay invoices", icon: CreditCard },
      { key: "can_respond_rfis", label: "Respond to RFIs", icon: Edit },
      { key: "can_submit_submittals", label: "Submit submittals", icon: Layers },
      { key: "can_approve_change_orders", label: "Approve COs", icon: CheckSquare },
      { key: "can_submit_selections", label: "Submit selections", icon: CheckSquare },
      { key: "can_create_punch_items", label: "Create punch items", icon: Flag },
      { key: "can_message", label: "Send messages", icon: MessageSquare },
    ],
  },
] as const

export function PermissionToggles({ value, onChange }: PermissionTogglesProps) {
  const merged = { ...DEFAULTS, ...value }

  const update = (key: keyof PortalPermissions, next: boolean) => {
    onChange({ ...merged, [key]: next })
  }

  return (
    <div className="space-y-3">
      {PERMISSION_GROUPS.map((group) => (
        <div key={group.label} className="space-y-1.5">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {group.label}
          </p>
          <div className="grid grid-cols-2 gap-1">
            {group.permissions.map(({ key, label, icon: Icon }) => {
              const enabled = !!merged[key as keyof PortalPermissions]
              return (
                <label
                  key={key}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 border px-2 py-1.5 transition-all",
                    enabled
                      ? "border-primary/20 bg-primary/5"
                      : "border-transparent bg-muted/50 hover:bg-muted"
                  )}
                >
                  <Switch
                    checked={enabled}
                    onCheckedChange={(checked) => update(key as keyof PortalPermissions, checked)}
                    className="data-[state=checked]:bg-primary h-4 w-7"
                  />
                  <span
                    className={cn(
                      "text-[10px] truncate",
                      enabled ? "text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {label}
                  </span>
                </label>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
