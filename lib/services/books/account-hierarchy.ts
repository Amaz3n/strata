/** Parent relationships organize accounts; they do not duplicate ledger postings. */
export interface HierarchyAccount {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
}

export function accountHierarchy<T extends HierarchyAccount>(accounts: T[]) {
  const sorted = [...accounts].sort((a, b) =>
    a.code.localeCompare(b.code, undefined, { numeric: true }),
  );
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const children = new Map<string | null, T[]>();
  for (const account of sorted) {
    const parent =
      account.parent_id && byId.has(account.parent_id)
        ? account.parent_id
        : null;
    children.set(parent, [...(children.get(parent) ?? []), account]);
  }
  const result: { account: T; depth: number; path: string }[] = [];
  const visited = new Set<string>();
  const visit = (account: T, depth: number, ancestors: string[]) => {
    if (visited.has(account.id)) return;
    visited.add(account.id);
    const path = [...ancestors, account.name];
    result.push({ account, depth, path: path.join(" / ") });
    for (const child of children.get(account.id) ?? [])
      visit(child, depth + 1, path);
  };
  for (const root of children.get(null) ?? []) visit(root, 0, []);
  // Keep legacy orphan/cyclic records visible rather than hiding financial accounts.
  for (const account of sorted)
    if (!visited.has(account.id)) visit(account, 0, []);
  return result;
}

export function assertAccountParent(
  parent: { org_id: string; account_type: string; active: boolean } | null,
  orgId: string,
  accountType: string,
) {
  if (!parent || parent.org_id !== orgId)
    throw new Error("Parent account not found in this organization");
  if (!parent.active) throw new Error("Choose an active parent account");
  if (parent.account_type !== accountType)
    throw new Error(
      "A subaccount must have the same account type as its parent",
    );
}
