import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const TONES: Record<string, string> = {
  planning: "border-border bg-muted text-muted-foreground",
  active: "border-primary/30 bg-primary/10 text-primary",
  sold_out: "border-border bg-secondary text-secondary-foreground",
  closed: "border-border bg-muted text-muted-foreground",
  controlled: "border-border bg-muted text-muted-foreground",
  owned: "border-primary/30 bg-primary/10 text-primary",
  developed: "border-border bg-secondary text-secondary-foreground",
  assigned: "border-border bg-muted text-muted-foreground",
  started: "border-primary/30 bg-primary/10 text-primary",
}

export function CommunityStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn("rounded-none text-[10px] font-medium uppercase tracking-wide", TONES[status])}>
      {status.replaceAll("_", " ")}
    </Badge>
  )
}
