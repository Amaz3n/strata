import type { TimePolicy } from "@/lib/time/policy";

// Splits a worker's week of hours into regular, overtime and double time. Daily
// thresholds apply first (hours past the daily overtime line are overtime, past
// the double-time line are double time); the remaining regular hours then count
// toward the weekly threshold, and regular hours past it are overtime.
//
// Entries are allocated in work order (date, then the order given), so the hours
// that cross a line belong to the entry that crossed it. Entries the office
// flagged by hand keep their flag and do not count toward regular hours.

export type OvertimeEntry = {
  id: string;
  workDate: string;
  hours: number;
  manual: "overtime" | "double_time" | null;
};

export type OvertimeSplit = {
  regular: number;
  overtime: number;
  doubleTime: number;
};

const hundredths = (hours: number) => Math.round(hours * 100);
const fromHundredths = (value: number) => value / 100;

export function allocateOvertime(
  entries: OvertimeEntry[],
  rule: Pick<
    TimePolicy,
    "weekly_overtime_hours" | "daily_overtime_hours" | "daily_double_time_hours"
  >,
): Map<string, OvertimeSplit> {
  const weekly = hundredths(rule.weekly_overtime_hours);
  const dailyOt =
    rule.daily_overtime_hours === null ? null : hundredths(rule.daily_overtime_hours);
  const dailyDt =
    rule.daily_double_time_hours === null
      ? null
      : hundredths(rule.daily_double_time_hours);
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        a.entry.workDate.localeCompare(b.entry.workDate) || a.index - b.index,
    );
  const dayWorked = new Map<string, number>();
  let weekRegular = 0;
  const result = new Map<string, OvertimeSplit>();
  for (const { entry } of ordered) {
    const total = hundredths(entry.hours);
    if (total <= 0) {
      result.set(entry.id, { regular: entry.hours, overtime: 0, doubleTime: 0 });
      continue;
    }
    const before = dayWorked.get(entry.workDate) ?? 0;
    dayWorked.set(entry.workDate, before + total);
    if (entry.manual) {
      result.set(entry.id, {
        regular: 0,
        overtime: entry.manual === "overtime" ? entry.hours : 0,
        doubleTime: entry.manual === "double_time" ? entry.hours : 0,
      });
      continue;
    }
    const after = before + total;
    const portion = (from: number, to: number) =>
      Math.max(0, Math.min(after, to) - Math.max(before, from));
    const doubleTime = dailyDt === null ? 0 : portion(dailyDt, Infinity);
    const dailyOvertime =
      dailyOt === null ? 0 : portion(dailyOt, dailyDt ?? Infinity);
    const candidate = total - doubleTime - dailyOvertime;
    const regular = Math.max(0, Math.min(candidate, weekly - weekRegular));
    weekRegular += regular;
    result.set(entry.id, {
      regular: fromHundredths(regular),
      overtime: fromHundredths(dailyOvertime + candidate - regular),
      doubleTime: fromHundredths(doubleTime),
    });
  }
  return result;
}

export type OvertimeKind = "regular" | "overtime" | "double_time";

export function splitParts(split: OvertimeSplit) {
  const parts: { kind: OvertimeKind; hours: number }[] = [];
  if (split.regular > 0) parts.push({ kind: "regular", hours: split.regular });
  if (split.overtime > 0) parts.push({ kind: "overtime", hours: split.overtime });
  if (split.doubleTime > 0)
    parts.push({ kind: "double_time", hours: split.doubleTime });
  return parts;
}

export function entryKind(entry: {
  is_overtime?: boolean | null;
  is_double_time?: boolean | null;
}): OvertimeKind {
  if (entry.is_double_time) return "double_time";
  if (entry.is_overtime) return "overtime";
  return "regular";
}
