// Hours a clock session earned: elapsed time less breaks, in hundredths of an hour.
// A clock left running past a day is capped at 24 hours and marked for review.
export const MAX_SESSION_HOURS = 24;

export function minutesBetween(from: string, to: string) {
  return Math.max(0, (Date.parse(to) - Date.parse(from)) / 60_000);
}

export function sessionHours(session: {
  started_at: string;
  ended_at: string;
  break_minutes: number;
}) {
  const worked =
    minutesBetween(session.started_at, session.ended_at) - session.break_minutes;
  const hours = Math.round((Math.max(0, worked) / 60) * 100) / 100;
  return { hours: Math.min(hours, MAX_SESSION_HOURS), capped: hours > MAX_SESSION_HOURS };
}

// The calendar day a clock-in belongs to, in the company's zone.
export function localWorkDate(at: Date, timeZone: string | null) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
