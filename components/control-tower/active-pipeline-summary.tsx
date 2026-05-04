import Link from "next/link";
import { ChevronDown } from "lucide-react";

import type { ControlTowerData } from "@/lib/services/dashboard";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const PIPELINE_STAGES = [
  {
    key: "new",
    label: "New",
    tone: "border-sky-500/30 bg-gradient-to-br from-sky-500/15 to-sky-500/5 text-sky-700 dark:text-sky-300",
  },
  {
    key: "contacted",
    label: "Contacted",
    tone: "border-slate-400/30 bg-gradient-to-br from-slate-400/15 to-slate-400/5 text-slate-700 dark:text-slate-300",
  },
  {
    key: "qualified",
    label: "Qualified",
    tone: "border-violet-500/30 bg-gradient-to-br from-violet-500/15 to-violet-500/5 text-violet-700 dark:text-violet-300",
  },
  {
    key: "estimating",
    label: "Estimating",
    tone: "border-amber-500/30 bg-gradient-to-br from-amber-500/15 to-amber-500/5 text-amber-700 dark:text-amber-300",
  },
  {
    key: "proposed",
    label: "Proposed",
    tone: "border-emerald-500/30 bg-gradient-to-br from-emerald-500/15 to-emerald-500/5 text-emerald-700 dark:text-emerald-300",
  },
] as const;

export function ActivePipelineSummary({
  pipeline,
}: {
  pipeline: ControlTowerData["pipeline"];
}) {
  const activeTotal = PIPELINE_STAGES.reduce(
    (sum, stage) => sum + (pipeline.byStatus[stage.key] ?? 0),
    0,
  );
  const won = pipeline.byStatus.won ?? 0;
  const lost = pipeline.byStatus.lost ?? 0;

  return (
    <section className="flex h-full flex-col bg-card px-4 py-4 sm:px-6">
      <header className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Pipeline
          </p>
          <h2 className="text-lg font-semibold tracking-tight">
            Active Pipeline
          </h2>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Badge variant="outline">{activeTotal} active</Badge>
          <Badge variant="secondary">{won} won</Badge>
          <Badge variant="secondary">{lost} lost</Badge>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-2">
        {PIPELINE_STAGES.map((stage, index) => {
          const count = pipeline.byStatus[stage.key] ?? 0;
          const share =
            activeTotal > 0 ? Math.round((count / activeTotal) * 100) : 0;

          return (
            <div key={stage.key} className="flex min-h-0 flex-1 flex-col">
              <Link
                href={`/pipeline?view=opportunities&status=${stage.key}`}
                className={cn(
                  "group relative flex min-h-[96px] flex-1 flex-col justify-between rounded-lg border px-4 py-3 shadow-sm transition-all hover:scale-[1.01] hover:shadow-md",
                  stage.tone,
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="text-xs font-semibold text-foreground">
                    {stage.label}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {share}%
                  </span>
                </div>
                <div>
                  <p className="text-3xl font-bold leading-none tabular-nums">
                    {count}
                  </p>
                </div>
              </Link>
              {index < PIPELINE_STAGES.length - 1 ? (
                <div className="flex h-5 items-center justify-center">
                  <ChevronDown className="h-4 w-4 text-muted-foreground/50" />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
