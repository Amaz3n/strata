export const REPORT_COLLECTIONS = [
  ["all", "All reports"],
  ["statements", "Financial statements"],
  ["projects", "Project financials"],
  ["cash", "Cash & payments"],
  ["operations", "Operations"],
  ["sales", "Sales & pipeline"],
  ["tax", "Tax"],
  ["compliance", "Compliance"],
] as const;
export function reportCollection(slug: string, group: string) {
  if (["vendor-1099", "sales-use-tax", "books-tax-workpaper"].includes(slug)) return "tax";
  if (slug.startsWith("books-")) return "statements";
  if (
    [
      "ar-aging",
      "ap-aging",
      "payments-ledger",
      "cash-flow-forecast",
      "draw-status",
      "pay-app-register",
    ].includes(slug)
  )
    return "cash";
  if (group === "compliance") return "compliance";
  if (
    group === "sales" ||
    ["closing-backlog", "sales-performance"].includes(slug)
  )
    return "sales";
  if (group === "production") return "operations";
  return "projects";
}
