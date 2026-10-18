export interface CostCodeHierarchyRecord {
  id: string
  code: string
  parent_id?: string | null
  is_active?: boolean | null
}

export type CostCodeHierarchyIssue = "cycle" | "missing_parent"

/** Analyze the full catalog, so a filtered-out parent is not mistaken for missing data. */
export function costCodeHierarchyIssues(codes: CostCodeHierarchyRecord[]) {
  const byId = new Map(codes.map(code => [code.id, code]))
  const resolved = new Map<string, CostCodeHierarchyIssue | null>()
  for (const code of codes) {
    if (resolved.has(code.id)) continue
    const path: string[] = []
    const inPath = new Set<string>()
    let current: string | null = code.id
    let issue: CostCodeHierarchyIssue | null = null
    while (current) {
      if (resolved.has(current)) {
        issue = resolved.get(current) ?? null
        break
      }
      if (inPath.has(current)) {
        issue = "cycle"
        break
      }
      const node = byId.get(current)
      if (!node) {
        issue = "missing_parent"
        break
      }
      path.push(current)
      inPath.add(current)
      current = node.parent_id ?? null
    }
    for (const key of path) resolved.set(key, issue)
  }
  return new Map(Array.from(resolved).filter((entry): entry is [string, CostCodeHierarchyIssue] => entry[1] !== null))
}

/** Every selected row stays visible; invalid branches are presented flat for repair. */
export function costCodeHierarchyRows<T extends CostCodeHierarchyRecord>(
  codes: T[],
  issues: ReadonlyMap<string, CostCodeHierarchyIssue> = costCodeHierarchyIssues(codes),
): Array<T & { depth: number; hierarchyIssue: CostCodeHierarchyIssue | null }> {
  const sorted = [...codes].sort((a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id))
  const selected = new Set(codes.map(code => code.id))
  const children = new Map<string | null, T[]>()
  for (const code of sorted) {
    const parent = !issues.has(code.id) && code.parent_id && selected.has(code.parent_id) ? code.parent_id : null
    const siblings = children.get(parent) ?? []
    siblings.push(code)
    children.set(parent, siblings)
  }
  const stack = (children.get(null) ?? []).map(code => ({ code, depth: 0 })).reverse()
  const rows: Array<T & { depth: number; hierarchyIssue: CostCodeHierarchyIssue | null }> = []
  while (stack.length) {
    const next = stack.pop()
    if (!next) break
    rows.push({ ...next.code, depth: next.depth, hierarchyIssue: issues.get(next.code.id) ?? null })
    const nested = children.get(next.code.id) ?? []
    for (let i = nested.length - 1; i >= 0; i--) stack.push({ code: nested[i], depth: next.depth + 1 })
  }
  return rows
}

/** Exclude the edited code, every descendant and branches the mutation service cannot validate. */
export function costCodeParentOptions<T extends CostCodeHierarchyRecord>(
  codes: T[],
  editedId?: string,
  issues: ReadonlyMap<string, CostCodeHierarchyIssue> = costCodeHierarchyIssues(codes),
): T[] {
  const children = new Map<string, string[]>()
  for (const code of codes) {
    if (!code.parent_id) continue
    const siblings = children.get(code.parent_id) ?? []
    siblings.push(code.id)
    children.set(code.parent_id, siblings)
  }
  const excluded = new Set<string>()
  const stack = editedId ? [editedId] : []
  while (stack.length) {
    const key = stack.pop()
    if (!key || excluded.has(key)) continue
    excluded.add(key)
    for (const child of children.get(key) ?? []) stack.push(child)
  }
  const depths = new Map(costCodeHierarchyRows(codes, issues).map(code => [code.id, code.depth]))
  return codes.filter(code => code.is_active !== false && !excluded.has(code.id) && !issues.has(code.id) && (depths.get(code.id) ?? 0) < 1_000)
    .sort((a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id))
}
