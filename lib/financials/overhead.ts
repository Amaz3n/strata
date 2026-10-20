import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts";

/**
 * Where an expense's cost lives: on a job, in overhead under a category, or
 * nowhere yet. Pure, so the rule that decides a receipt's account is tested
 * without a database.
 *
 * The category list moves together with project_expenses_overhead_category_check
 * (supabase/migrations/20261028100000_overhead_expenses.sql).
 */
export const OVERHEAD_CATEGORIES = [
  "fuel_vehicles",
  "tools_equipment",
  "shop_supplies",
  "meals_travel",
  "software",
  "insurance",
  "rent",
  "utilities",
  "professional_fees",
  "other",
] as const;

export type OverheadCategory = (typeof OVERHEAD_CATEGORIES)[number];

export const OVERHEAD_CATEGORY_LABELS: Record<OverheadCategory, string> = {
  fuel_vehicles: "Fuel and vehicles",
  tools_equipment: "Tools and small equipment",
  shop_supplies: "Shop and office supplies",
  meals_travel: "Meals and travel",
  software: "Software and subscriptions",
  insurance: "Insurance",
  rent: "Rent",
  utilities: "Utilities",
  professional_fees: "Professional fees",
  other: "Other overhead",
};

const OVERHEAD_ACCOUNT_CODES: Record<OverheadCategory, string> = {
  fuel_vehicles: SYSTEM_ACCOUNT_CODES.vehiclesFuel,
  tools_equipment: SYSTEM_ACCOUNT_CODES.toolsEquipment,
  shop_supplies: SYSTEM_ACCOUNT_CODES.shopSupplies,
  meals_travel: SYSTEM_ACCOUNT_CODES.mealsTravel,
  software: SYSTEM_ACCOUNT_CODES.softwareExpense,
  insurance: SYSTEM_ACCOUNT_CODES.insuranceExpense,
  rent: SYSTEM_ACCOUNT_CODES.rentExpense,
  utilities: SYSTEM_ACCOUNT_CODES.utilitiesExpense,
  professional_fees: SYSTEM_ACCOUNT_CODES.professionalFees,
  other: SYSTEM_ACCOUNT_CODES.otherExpense,
};

export function isOverheadCategory(value: unknown): value is OverheadCategory {
  return typeof value === "string" && (OVERHEAD_CATEGORIES as readonly string[]).includes(value);
}

/** The operating-expense account an overhead category posts to in Books. */
export function overheadAccountCode(category: OverheadCategory) {
  return OVERHEAD_ACCOUNT_CODES[category];
}

export type ExpenseHome =
  | { kind: "job"; projectId: string }
  | { kind: "overhead"; category: OverheadCategory }
  | { kind: "unsorted" };

export function expenseHome(row: { project_id: string | null; overhead_category: string | null }): ExpenseHome {
  if (row.project_id) return { kind: "job", projectId: row.project_id };
  if (isOverheadCategory(row.overhead_category)) return { kind: "overhead", category: row.overhead_category };
  return { kind: "unsorted" };
}

export function expenseHomeLabel(home: ExpenseHome, jobName?: string | null) {
  if (home.kind === "job") return jobName ?? "Job";
  if (home.kind === "overhead") return OVERHEAD_CATEGORY_LABELS[home.category];
  return "Needs a job or category";
}

/** An expense reaches the ledger only once it has a home and is approved. */
export function expenseApprovalRefusal(row: { project_id: string | null; overhead_category: string | null }) {
  return expenseHome(row).kind === "unsorted"
    ? "Pick a job or an overhead category before approving this expense."
    : null;
}

/**
 * The job a receipt captured without one most likely belongs to: the job the
 * person was clocked into when the receipt was dated, else the one they spent
 * the most time on that day. Sessions are that person's, for that day.
 */
export function suggestJobFromClock(input: {
  /** The receipt's local time of purchase when the scan found one. */
  at?: string | null;
  sessions: ReadonlyArray<{ projectId: string; startedAt: string; endedAt: string | null }>;
  now: string;
}): string | null {
  if (input.sessions.length === 0) return null;
  const at = input.at ? Date.parse(input.at) : Number.NaN;
  if (Number.isFinite(at)) {
    const during = input.sessions.find((session) => {
      const start = Date.parse(session.startedAt);
      const end = session.endedAt ? Date.parse(session.endedAt) : Date.parse(input.now);
      return start <= at && at <= end;
    });
    if (during) return during.projectId;
  }
  const minutes = new Map<string, number>();
  for (const session of input.sessions) {
    const end = session.endedAt ? Date.parse(session.endedAt) : Date.parse(input.now);
    const span = Math.max(0, end - Date.parse(session.startedAt));
    minutes.set(session.projectId, (minutes.get(session.projectId) ?? 0) + span);
  }
  let best: string | null = null;
  let bestSpan = -1;
  for (const [projectId, span] of minutes) {
    if (span > bestSpan) {
      best = projectId;
      bestSpan = span;
    }
  }
  return best;
}
