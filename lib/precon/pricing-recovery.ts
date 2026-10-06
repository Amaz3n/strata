import type { PricingWorksheet } from "./pricing-worksheet";

export type PricingConflict = { field: string; local: unknown; remote: unknown };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Three-way merge: independent row/field edits survive server mutations and reloads. */
export function mergePricingWorksheet(base: PricingWorksheet, local: PricingWorksheet, remote: PricingWorksheet) {
  const conflicts: PricingConflict[] = [];
  function merge(before: unknown, mine: unknown, theirs: unknown, path: string): unknown {
    if (same(mine, before)) return theirs;
    if (same(theirs, before) || same(mine, theirs)) return mine;
    if ((path === "rows" || path === "requests") && Array.isArray(before) && Array.isArray(mine) && Array.isArray(theirs)) {
      const key = path === "rows" ? "id" : "package_id";
      const keyed = (items: unknown[]) => new Map(items.filter(record).map(item => [item[key], item]));
      const previous = keyed(before), local = keyed(mine), remote = keyed(theirs);
      const ids = new Set([...remote.keys(), ...local.keys()]);
      return [...ids].map(id => merge(previous.get(id), local.get(id), remote.get(id), `${path}.${id}`)).filter(item => item !== undefined);
    }
    if (record(before) && record(mine) && record(theirs)) {
      return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(mine), ...Object.keys(theirs)])].map(key => [key, merge(before[key], mine[key], theirs[key], path ? `${path}.${key}` : key)]));
    }
    conflicts.push({ field: path, local: mine, remote: theirs });
    return mine;
  }
  return { worksheet: merge(base, local, remote, "") as PricingWorksheet, conflicts };
}
