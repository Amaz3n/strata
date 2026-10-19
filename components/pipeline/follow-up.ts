/**
 * A follow-up is a day, read in the browser's own zone: it lands at nine that
 * morning (the server's `followUpAt`), so "today" is the day it falls on here.
 */

/** A date input's value for a moment, in this browser's zone. */
export function localDay(at: Date = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

export function dayAfter(days: number, from: Date = new Date()): string {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  return localDay(date);
}

/** Whole days from today to the follow-up: negative is late, zero is today. */
export function daysUntil(at: string | Date, today: Date): number {
  const due = new Date(at);
  const start = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((start(due) - start(today)) / 86_400_000);
}

/** The quick picks a follow-up offers, in the order people reach for them. */
export function followUpChoices(today: Date): Array<{ label: string; on: string }> {
  const monday = new Date(today);
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  return [
    { label: "Tomorrow", on: dayAfter(1, today) },
    { label: "In 3 days", on: dayAfter(3, today) },
    { label: "Next Monday", on: localDay(monday) },
    { label: "In 2 weeks", on: dayAfter(14, today) },
  ];
}

/** "Thu, Oct 23" for a day input value or a moment. */
export function shortDay(at: string | Date, today: Date): string {
  const date = typeof at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(at) ? new Date(`${at}T09:00:00`) : new Date(at);
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== today.getFullYear() && { year: "numeric" }),
  });
}

/** When it falls, in words, and the tone that says whether it is late. */
export function followUpWhen(at: string, today: Date): { label: string; tone: string } {
  const days = daysUntil(at, today);
  if (days < 0) return { label: `${-days} ${days === -1 ? "day" : "days"} late`, tone: "text-age-2" };
  if (days === 0) return { label: "Today", tone: "text-warning" };
  if (days === 1) return { label: "Tomorrow", tone: "text-primary" };
  return { label: `In ${days} days`, tone: "text-muted-foreground" };
}
