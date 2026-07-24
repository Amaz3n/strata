import { Badge } from "@/components/ui/badge"
import type { StartPackageStatus } from "@/lib/services/starts"
import { cn } from "@/lib/utils"

const STATUS_TONES: Record<StartPackageStatus, string> = {
  open: "border-border bg-muted text-muted-foreground",
  ready: "border-primary/30 bg-primary/10 text-primary",
  releasing: "border-primary/30 bg-primary/10 text-primary",
  released: "border-border bg-secondary text-secondary-foreground",
  attention: "border-destructive/30 bg-destructive/10 text-destructive",
  cancelled: "border-border bg-secondary text-secondary-foreground",
}

export function StartStatusBadge({ status }: { status: StartPackageStatus }) {
  return (
    <Badge variant="outline" className={cn("rounded-none text-[10px] font-medium uppercase tracking-wide", STATUS_TONES[status])}>
      {status}
    </Badge>
  )
}

const GATE_TONES: Record<string, { label: string; tone: string }> = {
  pending: { label: "Pending", tone: "border-border bg-muted text-muted-foreground" },
  passed: { label: "Passed", tone: "border-primary/30 bg-primary/10 text-primary" },
  waived: { label: "Waived", tone: "border-warning/40 bg-warning/10 text-warning" },
  not_applicable: { label: "N/A", tone: "border-border bg-secondary text-secondary-foreground" },
}

export function GateStatusBadge({ status }: { status: string }) {
  const meta = GATE_TONES[status] ?? GATE_TONES.pending
  return (
    <Badge variant="outline" className={cn("rounded-none text-[10px] font-medium uppercase tracking-wide", meta.tone)}>
      {meta.label}
    </Badge>
  )
}

const STEP_TONES: Record<string, string> = {
  pending: "border-border bg-muted text-muted-foreground",
  running: "border-primary/30 bg-primary/10 text-primary",
  completed: "border-primary/30 bg-primary/10 text-primary",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
}

export function ReleaseStepBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn("rounded-none text-[10px] font-medium uppercase tracking-wide", STEP_TONES[status] ?? STEP_TONES.pending)}>
      {status.replaceAll("_", " ")}
    </Badge>
  )
}
