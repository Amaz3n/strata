/** Close review presentation rules. The server reruns all controls at close time. */
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
