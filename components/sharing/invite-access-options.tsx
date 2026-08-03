"use client"

import { format, parseISO } from "date-fns"

import { ChevronDown, Clock, Eye, Lock, Settings, Shield } from "@/components/icons"

import type { PortalPermissions } from "@/lib/types"
import { cn } from "@/lib/utils"
import { PermissionToggles } from "@/components/sharing/permission-toggles"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export type PermissionPreset = "standard" | "read_only" | "custom"

const PRESETS: Array<{ value: PermissionPreset; label: string; icon: typeof Shield }> = [
  { value: "standard", label: "Standard", icon: Shield },
  { value: "read_only", label: "View only", icon: Eye },
  { value: "custom", label: "Custom", icon: Settings },
]

export interface InviteAccessOptionsProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  expiresAt: string
  onExpiresAtChange: (value: string) => void
  defaultExpires: string
  requirePin: boolean
  onRequirePinChange: (value: boolean) => void
  pin: string
  onPinChange: (value: string) => void
  preset: PermissionPreset
  onPresetChange: (value: PermissionPreset) => void
  permissions: Partial<PortalPermissions>
  onPermissionsChange: (value: Partial<PortalPermissions>) => void
}

/**
 * Expiry, PIN and permissions — everything that is a property of the access
 * rather than of the person. Collapsed by default: the common invite is a
 * teammate of the project with standard permissions, and asking about PINs up
 * front made a two-field task look like a form.
 */
export function InviteAccessOptions({
  open,
  onOpenChange,
  expiresAt,
  onExpiresAtChange,
  defaultExpires,
  requirePin,
  onRequirePinChange,
  pin,
  onPinChange,
  preset,
  onPresetChange,
  permissions,
  onPermissionsChange,
}: InviteAccessOptionsProps) {
  const expiryLabel = expiresAt ? format(parseISO(expiresAt), "MMM d, yyyy") : null
  const summary = [
    preset === "standard" ? "Standard access" : preset === "read_only" ? "View only" : "Custom access",
    expiryLabel ? `expires ${expiryLabel}` : "no expiry",
    requirePin ? "PIN on" : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="border border-border">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/30",
            open && "border-b border-border",
          )}
        >
          <span className="min-w-0">
            <span className="block text-xs font-medium">Access options</span>
            {!open ? (
              <span className="block truncate text-[11px] text-muted-foreground">{summary}</span>
            ) : null}
          </span>
          <ChevronDown
            className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="space-y-4 p-3">
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Clock className="size-3.5" />
              <Label className="text-[11px] font-medium">Expires</Label>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                type="button"
                variant={!expiresAt ? "secondary" : "outline"}
                onClick={() => onExpiresAtChange("")}
                className="h-7 text-xs"
              >
                Never
              </Button>
              <Button
                size="sm"
                type="button"
                variant={expiresAt === defaultExpires ? "secondary" : "outline"}
                onClick={() => onExpiresAtChange(defaultExpires)}
                className="h-7 text-xs"
              >
                90 days
              </Button>
              <Input
                type="date"
                value={expiresAt}
                onChange={(event) => onExpiresAtChange(event.target.value)}
                className="h-7 w-auto px-2 text-xs"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Lock className="size-3.5" />
                <Label className="text-[11px] font-medium">PIN</Label>
              </div>
              <Button
                size="sm"
                type="button"
                variant={requirePin ? "secondary" : "outline"}
                className="h-6 px-2 text-[11px]"
                onClick={() => onRequirePinChange(!requirePin)}
              >
                {requirePin ? "On" : "Off"}
              </Button>
            </div>
            {requirePin ? (
              <Input
                type="password"
                inputMode="numeric"
                maxLength={6}
                placeholder="4-6 digits"
                value={pin}
                onChange={(event) => onPinChange(event.target.value)}
                className="h-8 font-mono text-xs tracking-widest"
              />
            ) : null}
            <p className="text-[11px] text-muted-foreground">
              Only applies to link-only access. Signing in already proves who someone is.
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Shield className="size-3.5" />
              <Label className="text-[11px] font-medium">Permissions</Label>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {PRESETS.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => onPresetChange(value)}
                  className={cn(
                    "flex flex-col items-center justify-center gap-1 border py-2 text-center transition-colors",
                    preset === value
                      ? "border-foreground bg-muted text-foreground"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="text-[10px] font-medium">{label}</span>
                </button>
              ))}
            </div>
            {preset === "custom" ? (
              <div className="border border-border bg-background p-3">
                <PermissionToggles value={permissions} onChange={onPermissionsChange} />
              </div>
            ) : null}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
