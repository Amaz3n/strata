/** Shared URL and presentation vocabulary for the banded payable register. */
export const PAYABLE_BANDS = [
  "drafts",
  "approval",
  "ready",
  "inflight",
  "credits",
  "paid",
] as const;
export type PayableBandKey = (typeof PAYABLE_BANDS)[number];
export const PAYABLE_BAND_LABELS: Record<PayableBandKey, string> = {
  drafts: "Drafts",
  approval: "Needs approval",
  ready: "Ready to pay",
  inflight: "In flight",
  credits: "Vendor credits",
  paid: "Paid",
};
export const PAYABLE_SORTS = [
  "vendor",
  "project",
  "invoice",
  "due",
  "amount",
  "status",
] as const;
export type PayableSort = (typeof PAYABLE_SORTS)[number];
export function parsePayableSort(value: unknown): PayableSort {
  return PAYABLE_SORTS.includes(value as PayableSort)
    ? (value as PayableSort)
    : "due";
}
export function payableBandPage(value: unknown) {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? Math.min(page, 100_000) : 1;
}
export function parsePayablesBookQuery(input: Record<string, unknown>) {
  return {
    banded: true as const,
    sort: parsePayableSort(input.sort),
    direction:
      input.direction === "desc" ? ("desc" as const) : ("asc" as const),
    includePaid:
      input.history === "1" || input.tab === "paid" || input.queue === "paid",
    bandPages: Object.fromEntries(
      PAYABLE_BANDS.map((key) => [key, payableBandPage(input[`page_${key}`])]),
    ) as Record<PayableBandKey, number>,
  };
}
