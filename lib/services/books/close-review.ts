/** Close review presentation rules. The server reruns all controls at close time. */

/** A freeze older than this is an abandoned close; mirrors begin_books_period_close. */
export const ABANDONED_CLOSE_MINUTES = 30;

/** A close that stopped between its freeze and its lock, and can be resumed. */
export function isAbandonedClose(status: string, closeStartedAt: string | null, now: Date) {
  if (status !== "reviewing") return false;
  if (!closeStartedAt) return true;
  return now.getTime() - new Date(closeStartedAt).getTime() > ABANDONED_CLOSE_MINUTES * 60_000;
}

export function closeReviewState<
  T extends {
    period_id: string;
    blocking: boolean;
    status: string;
    evidence: unknown;
  },
>(checks: T[], periodId: string) {
  const rows = checks.filter((check) => {
    const evidence =
      check.evidence && typeof check.evidence === "object"
        ? (check.evidence as { applicable?: boolean })
        : null;
    return check.period_id === periodId && evidence?.applicable !== false;
  });
  const blockers = rows.filter(
    (check) => check.blocking && check.status !== "passed",
  );
  return {
    rows,
    blockers,
    attention: rows.filter((check) => check.status !== "passed"),
    passed: rows.filter((check) => check.status === "passed").length,
    ready: rows.length > 0 && blockers.length === 0,
  };
}
