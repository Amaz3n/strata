import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { OptimisticLink } from "@/lib/navigation/optimistic-pathname";

/** Plans, files and full quote packages open over the deal; this is the way back. */
export function DealTakeoverBar({ dealId, title, children }: { dealId: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b bg-background px-4">
      <OptimisticLink
        href={`/pipeline/${dealId}`}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to the deal
      </OptimisticLink>
      <span className="text-xs text-muted-foreground" aria-hidden>
        /
      </span>
      <h2 className="text-sm font-semibold">{title}</h2>
      {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
    </div>
  );
}
