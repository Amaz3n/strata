export function formatBankDate(value: string) {
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${month}/${day}/${year}` : value;
}

export function bankingPaginationItems(current: number, total: number) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index);
  const pages = new Set([0, total - 1, current - 1, current, current + 1]);
  const valid = [...pages]
    .filter((item) => item >= 0 && item < total)
    .sort((a, b) => a - b);
  const result: Array<number | "ellipsis"> = [];
  for (const item of valid) {
    const previous = result[result.length - 1];
    if (typeof previous === "number" && item - previous > 1)
      result.push("ellipsis");
    result.push(item);
  }
  return result;
}

export function bankingOptimisticCounts(
  counts: Record<string, number>,
  bankAccountId: string,
  direction: "post" | "rollback",
) {
  const reviewKey = `${bankAccountId}:review`;
  const postedKey = `${bankAccountId}:posted`;
  const delta = direction === "post" ? 1 : -1;
  return {
    ...counts,
    [reviewKey]: Math.max(0, (counts[reviewKey] ?? 0) - delta),
    [postedKey]: Math.max(0, (counts[postedKey] ?? 0) + delta),
  };
}
