import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/** Color is state: green healthy, amber needs a human, red broken, neutral absent. */
export type ConnectionTone = "ok" | "warn" | "error" | "idle"

const TONE_CLASSES: Record<ConnectionTone, string> = {
  ok: "border-success/20 bg-success/10 text-success",
  warn: "border-warning/20 bg-warning/10 text-warning",
  error: "border-destructive/20 bg-destructive/10 text-destructive",
  idle: "border-border bg-muted text-muted-foreground",
}

export function ConnectionStatusBadge({ tone, label, className }: { tone: ConnectionTone; label: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("h-5 shrink-0 rounded-full px-2 text-[10px] font-medium", TONE_CLASSES[tone], className)}>
      {label}
    </Badge>
  )
}

export function accountingStatusTone(status: string): ConnectionTone {
  switch (status) {
    case "active":
      return "ok"
    case "expired":
      return "warn"
    case "error":
      return "error"
    default:
      return "idle"
  }
}

export function accountingStatusLabel(status: string): string {
  switch (status) {
    case "active":
      return "Connected"
    case "expired":
      return "Reauthorize"
    case "error":
      return "Error"
    default:
      return "Disconnected"
  }
}
