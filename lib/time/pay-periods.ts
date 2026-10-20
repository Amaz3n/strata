import type { TimePolicy } from "@/lib/time/policy";

// Dates are calendar days (YYYY-MM-DD) handled in UTC so no zone shifts them.
const DAY_MS = 86_400_000;

function toDay(date: string) {
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
}

function fromDay(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number) {
  return fromDay(toDay(date) + days * DAY_MS);
}

export function daysBetween(from: string, to: string) {
  return Math.round((toDay(to) - toDay(from)) / DAY_MS);
}

export type PayPeriodRange = { startsOn: string; endsOn: string };

function periodLength(policy: TimePolicy) {
  return policy.pay_frequency === "weekly" ? 7 : 14;
}

export function payPeriodFor(date: string, policy: TimePolicy): PayPeriodRange {
  const length = periodLength(policy);
  const offset = daysBetween(policy.pay_anchor_date, date);
  const index = Math.floor(offset / length);
  const startsOn = addDays(policy.pay_anchor_date, index * length);
  return { startsOn, endsOn: addDays(startsOn, length - 1) };
}

export function previousPayPeriod(
  period: PayPeriodRange,
  policy: TimePolicy,
): PayPeriodRange {
  return payPeriodFor(addDays(period.startsOn, -1), policy);
}

// Overtime weeks start on the anchor's weekday so a biweekly period is two whole weeks.
export function workWeekFor(date: string, policy: TimePolicy): PayPeriodRange {
  const offset = daysBetween(policy.pay_anchor_date, date);
  const startsOn = addDays(policy.pay_anchor_date, Math.floor(offset / 7) * 7);
  return { startsOn, endsOn: addDays(startsOn, 6) };
}

export function datesIn(range: PayPeriodRange) {
  const count = daysBetween(range.startsOn, range.endsOn) + 1;
  return Array.from({ length: count }, (_, index) => addDays(range.startsOn, index));
}

export function isPayPeriodRange(range: PayPeriodRange, policy: TimePolicy) {
  const period = payPeriodFor(range.startsOn, policy);
  return period.startsOn === range.startsOn && period.endsOn === range.endsOn;
}
