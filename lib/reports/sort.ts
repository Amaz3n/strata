import { unwrapCell } from "./format";
import type { ReportRow } from "./types";
/** Sort detail rows inside their existing sections; never move financial totals. */
export function sortReportRows(
  rows: ReportRow[],
  key: string,
  descending = false,
): ReportRow[] {
  const compare = (a: ReportRow, b: ReportRow) => {
    const ac = unwrapCell(a.cells[key]),
      bc = unwrapCell(b.cells[key]);
    const av = ac.label ?? ac.value,
      bv = bc.label ?? bc.value;
    if (av == null) return bv == null ? 0 : 1;
    if (bv == null) return -1;
    const result =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, {
            numeric: true,
            sensitivity: "base",
          });
    return descending ? -result : result;
  };
  const sorted: ReportRow[] = [];
  let bucket: ReportRow[] = [];
  const flush = () => {
    sorted.push(...bucket.sort(compare));
    bucket = [];
  };
  for (const row of rows) {
    const next = row.children
      ? { ...row, children: sortReportRows(row.children, key, descending) }
      : row;
    if (row.emphasis) {
      flush();
      sorted.push(next);
    } else bucket.push(next);
  }
  flush();
  return sorted;
}
