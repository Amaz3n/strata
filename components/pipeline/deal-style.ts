import type { DealBall } from "@/lib/precon/deal-move";

/**
 * Whose move it is. The colour reports who holds the deal, nothing else;
 * `chip` labels the deal header's next move and `edge` is its leading border.
 */
export const BALL_STYLE: Record<DealBall, { label: string; dot: string; chip: string; edge: string }> = {
  you: { label: "Your move", dot: "bg-warning", chip: "bg-warning/12 text-warning", edge: "border-l-warning" },
  trades: { label: "Waiting on trades", dot: "bg-chart-2", chip: "bg-chart-2/12 text-chart-2", edge: "border-l-chart-2" },
  client: { label: "Waiting on clients", dot: "bg-primary", chip: "bg-primary/10 text-primary", edge: "border-l-primary" },
  building: { label: "Started", dot: "bg-success", chip: "bg-success/12 text-success", edge: "border-l-success" },
  closed: { label: "Lost", dot: "bg-muted-foreground", chip: "bg-muted text-muted-foreground", edge: "border-l-muted-foreground/40" },
};

/**
 * One tone per open stop in `DEAL_STOPS`, in order (Building is the project's, not the pipeline's). The funnel card and the stage
 * badge read the same entry so a stage looks the same wherever it appears;
 * `accent` is the edge a table row shows on hover.
 */
export const STOP_STYLE = [
  {
    card: "from-chart-1/10 to-chart-1/5 border-chart-1/30 dark:from-chart-1/20 dark:to-chart-1/10",
    text: "text-chart-1",
    bar: "bg-chart-1",
    ring: "ring-chart-1/50",
    badge: "bg-chart-1/15 text-chart-1 border-chart-1/30",
    accent: "group-hover:bg-chart-1",
  },
  {
    card: "from-chart-3/10 to-chart-3/5 border-chart-3/30 dark:from-chart-3/20 dark:to-chart-3/10",
    text: "text-chart-3",
    bar: "bg-chart-3",
    ring: "ring-chart-3/50",
    badge: "bg-chart-3/15 text-chart-3 border-chart-3/30",
    accent: "group-hover:bg-chart-3",
  },
  {
    card: "from-chart-5/10 to-chart-5/5 border-chart-5/30 dark:from-chart-5/20 dark:to-chart-5/10",
    text: "text-chart-5",
    bar: "bg-chart-5",
    ring: "ring-chart-5/50",
    badge: "bg-chart-5/15 text-chart-5 border-chart-5/30",
    accent: "group-hover:bg-chart-5",
  },
  {
    card: "from-chart-2/10 to-chart-2/5 border-chart-2/30 dark:from-chart-2/20 dark:to-chart-2/10",
    text: "text-chart-2",
    bar: "bg-chart-2",
    ring: "ring-chart-2/50",
    badge: "bg-chart-2/15 text-chart-2 border-chart-2/30",
    accent: "group-hover:bg-chart-2",
  },
] as const;
