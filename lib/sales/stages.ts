import type { SalesDealStage } from "@/lib/services/sales-deals"

/**
 * The visible track, in order. `lost` is deliberately absent — it is a terminal
 * state off to the side, not a step every buyer passes through.
 */
export const STAGE_TRACK: SalesDealStage[] = [
  "inquiry",
  "working",
  "hold",
  "contract",
  "building",
  "closing",
  "closed",
]

/** Plain language, the way a sales consultant says it out loud. */
export const STAGE_LABELS: Record<SalesDealStage, string> = {
  lost: "Lost",
  inquiry: "New inquiry",
  working: "Working",
  hold: "Lot on hold",
  contract: "Under contract",
  building: "Building",
  closing: "Closing",
  closed: "Closed",
}

/**
 * The stages the funnel bar shows. `closed` is absent because the open board
 * never loads a settled home, and `lost` is off to the side, not a step.
 */
export const FUNNEL_STAGES: SalesDealStage[] = ["inquiry", "working", "hold", "contract", "building", "closing"]

/**
 * One accent per stage. Colour here means *which stage*, and it is confined to
 * the funnel and the row's stage chip — the next-action column still reserves
 * colour for lateness, so the two signals never compete.
 *
 * Hues come from the chart tokens rather than raw Tailwind palettes, so the set
 * shifts with the theme and stays legible in dark mode.
 */
export interface StageAccent {
  text: string
  bar: string
  border: string
  /** Tinted card wash for the funnel. */
  gradient: string
  ring: string
  /** Tinted chip for the stage badge on a board row. */
  chip: string
}

export const STAGE_ACCENT: Record<SalesDealStage, StageAccent> = {
  lost: {
    text: "text-muted-foreground",
    bar: "bg-muted-foreground/40",
    border: "border-border",
    gradient: "from-muted/60 to-muted/20",
    ring: "ring-muted-foreground/40",
    chip: "bg-muted text-muted-foreground border-border",
  },
  inquiry: {
    text: "text-chart-2",
    bar: "bg-chart-2",
    border: "border-chart-2/30",
    gradient: "from-chart-2/15 to-chart-2/5 dark:from-chart-2/25 dark:to-chart-2/10",
    ring: "ring-chart-2/50",
    chip: "bg-chart-2/10 text-chart-2 border-chart-2/30",
  },
  working: {
    text: "text-chart-1",
    bar: "bg-chart-1",
    border: "border-chart-1/30",
    gradient: "from-chart-1/15 to-chart-1/5 dark:from-chart-1/25 dark:to-chart-1/10",
    ring: "ring-chart-1/50",
    chip: "bg-chart-1/10 text-chart-1 border-chart-1/30",
  },
  hold: {
    text: "text-chart-3",
    bar: "bg-chart-3",
    border: "border-chart-3/30",
    gradient: "from-chart-3/15 to-chart-3/5 dark:from-chart-3/25 dark:to-chart-3/10",
    ring: "ring-chart-3/50",
    chip: "bg-chart-3/10 text-chart-3 border-chart-3/30",
  },
  contract: {
    text: "text-chart-5",
    bar: "bg-chart-5",
    border: "border-chart-5/30",
    gradient: "from-chart-5/15 to-chart-5/5 dark:from-chart-5/25 dark:to-chart-5/10",
    ring: "ring-chart-5/50",
    chip: "bg-chart-5/10 text-chart-5 border-chart-5/30",
  },
  building: {
    text: "text-chart-4",
    bar: "bg-chart-4",
    border: "border-chart-4/30",
    gradient: "from-chart-4/15 to-chart-4/5 dark:from-chart-4/25 dark:to-chart-4/10",
    ring: "ring-chart-4/50",
    chip: "bg-chart-4/10 text-chart-4 border-chart-4/30",
  },
  closing: {
    text: "text-success",
    bar: "bg-success",
    border: "border-success/30",
    gradient: "from-success/15 to-success/5 dark:from-success/25 dark:to-success/10",
    ring: "ring-success/50",
    chip: "bg-success/10 text-success border-success/30",
  },
  closed: {
    text: "text-success",
    bar: "bg-success",
    border: "border-success/30",
    gradient: "from-success/15 to-success/5 dark:from-success/25 dark:to-success/10",
    ring: "ring-success/50",
    chip: "bg-success/10 text-success border-success/30",
  },
}

/** Stages that can carry a price. Early ones never do, so the value line hides. */
export const STAGE_BEARS_VALUE: Record<SalesDealStage, boolean> = {
  lost: false,
  inquiry: false,
  working: false,
  hold: true,
  contract: true,
  building: true,
  closing: true,
  closed: true,
}

/** Short form for the stage track, where the column is narrow. */
export const STAGE_SHORT_LABELS: Record<SalesDealStage, string> = {
  lost: "Lost",
  inquiry: "Inquiry",
  working: "Working",
  hold: "On hold",
  contract: "Contract",
  building: "Building",
  closing: "Closing",
  closed: "Closed",
}
