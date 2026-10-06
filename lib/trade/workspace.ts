import { z } from "zod";

const day = z.string().date();
export const tradeJobSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    client_id: z.string().uuid().optional(),
    address: z.string().trim().max(500).default(""),
    description: z.string().trim().max(4000).default(""),
    property_type: z.enum(["residential", "commercial"]).default("residential"),
    billing_model: z
      .enum(["fixed_price", "time_and_materials"])
      .default("fixed_price"),
    total_contract_value_cents: z
      .number()
      .int()
      .min(0)
      .max(2_147_483_647)
      .optional(),
    start_date: day.optional(),
    end_date: day.optional(),
  })
  .refine(
    (input) =>
      !input.start_date ||
      !input.end_date ||
      input.start_date <= input.end_date,
    {
      message: "The finish date must be on or after the start date.",
      path: ["end_date"],
    },
  );

export const tradeWorkSchema = z
  .object({
    project_id: z.string().uuid(),
    name: z.string().trim().min(2).max(200),
    start_date: day,
    end_date: day,
    assigned_to: z.string().uuid().optional(),
    planned_hours: z.number().positive().max(10000).optional(),
    notes: z.string().trim().max(2000).default(""),
  })
  .refine((input) => input.start_date <= input.end_date, {
    message: "The finish date must be on or after the start date.",
    path: ["end_date"],
  });

export const ELECTRICAL_WORK = [
  "Underground & service",
  "Rough-in",
  "Rough inspection",
  "Trim-out",
  "Fixtures & devices",
  "Testing & final inspection",
  "Punch & closeout",
];

export interface CrewWork {
  id: string;
  project_id: string;
  name: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  assigned_to: string | null;
  planned_hours: number | null;
}

/** Inclusive dates: two jobs on the same day are a conflict for one lead. */
export function crewConflicts(items: CrewWork[]): Set<string> {
  const result = new Set<string>();
  const live = items.filter(
    (item) =>
      item.assigned_to &&
      item.start_date &&
      !["completed", "cancelled"].includes(item.status),
  );
  for (let a = 0; a < live.length; a++) {
    for (let b = a + 1; b < live.length; b++) {
      const left = live[a],
        right = live[b];
      if (
        left.assigned_to !== right.assigned_to ||
        left.project_id === right.project_id
      )
        continue;
      const leftStart = left.start_date,
        rightStart = right.start_date;
      if (
        leftStart &&
        rightStart &&
        leftStart <= (right.end_date ?? rightStart) &&
        rightStart <= (left.end_date ?? leftStart)
      ) {
        result.add(left.id);
        result.add(right.id);
      }
    }
  }
  return result;
}
