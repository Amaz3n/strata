import type { ReactNode } from "react"

import { AlertCircle } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

/**
 * A settings group: a microlabel, then hairline-separated fields. Groups are
 * told apart by whitespace, not by enclosure — no panel, no tinted header.
 */
export function SettingsGroup({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={className}>
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h2 className="microlabel">{title}</h2>
        {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
      </div>
      {description ? <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{description}</p> : null}
      <div className={cn("divide-y divide-border border-t border-border", description ? "mt-3" : "mt-2")}>{children}</div>
    </section>
  )
}

/**
 * One field. Defaults to `split` — label and hint take the width on the left, the
 * control sits in a fixed column pinned right, so a one-line hint stays one line.
 * Pass `layout="stacked"` inside narrow containers (side panes, sheets): the split grid
 * keys off viewport `sm:`, not container width, so it would squeeze controls there.
 */
export function SettingsField({
  label,
  htmlFor,
  hint,
  children,
  className,
  layout = "split",
}: {
  label: ReactNode
  htmlFor?: string
  hint?: string
  children: ReactNode
  className?: string
  layout?: "split" | "stacked"
}) {
  const stacked = layout === "stacked"
  return (
    <div
      className={cn(
        "grid gap-2 py-4",
        !stacked && "sm:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] sm:gap-8",
        className,
      )}
    >
      <div className={cn("min-w-0", !stacked && "sm:pt-1.5")}>
        <Label htmlFor={htmlFor} className="text-sm font-medium leading-5 text-foreground">
          {label}
        </Label>
        {hint ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/**
 * One toggle: label and hint on the left, the switch pinned right. Mirrors
 * SettingsField's typography without its two-column grid, which would float the
 * switch mid-row.
 */
export function SettingsToggle({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  id: string
  label: string
  description: ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-4">
      <div className="min-w-0">
        <Label
          htmlFor={id}
          className={cn("text-sm font-medium leading-5", disabled ? "text-muted-foreground" : "text-foreground")}
        >
          {label}
        </Label>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="mt-0.5 shrink-0"
      />
    </div>
  )
}

/**
 * A read-only fact row — mirrors SettingsField's grid, but both columns share a
 * baseline since there's no control to top-align.
 */
export function InfoRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="grid gap-1 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] sm:gap-8">
      <div className="min-w-0">
        <p className="text-sm font-medium leading-5 text-foreground">{label}</p>
        {hint ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="min-w-0 text-sm leading-5 text-foreground">{children}</div>
    </div>
  )
}

/**
 * Summary on the left, an Edit button on the right — the shape every editable row
 * in Settings uses. Editing itself always happens in a dialog.
 */
export function RowControl({
  children,
  onEdit,
  canManage,
  buttonLabel = "Edit",
  align = "center",
}: {
  children: ReactNode
  onEdit: () => void
  canManage: boolean
  buttonLabel?: string
  /** `start` keeps the button on the first line when the summary runs several lines deep. */
  align?: "center" | "start"
}) {
  return (
    <div className={cn("flex justify-between gap-3", align === "start" ? "items-start" : "items-center")}>
      <div className="min-w-0 flex-1">{children}</div>
      <Button variant="outline" size="sm" className="shrink-0" onClick={onEdit} disabled={!canManage}>
        {buttonLabel}
      </Button>
    </div>
  )
}

/** The one inline error style these forms use. */
export function SettingsError({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={cn("flex items-start gap-1.5 text-xs leading-5 text-destructive", className)}>
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}
