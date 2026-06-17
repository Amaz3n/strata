import "server-only"

export function buildTextSearchOrCondition(searchFields: string[], rawQuery: string) {
  const cleaned = rawQuery.replace(/[,%()]/g, " ").trim()
  if (!cleaned) return ""
  return searchFields
    .filter((field) => field && !field.includes("."))
    .map((field) => `${field}.ilike.%${cleaned}%`)
    .join(",")
}
