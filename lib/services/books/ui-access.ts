import "server-only";

import { cache } from "react";
import { authorize } from "@/lib/services/authorization";
import { requireOrgContext } from "@/lib/services/context";
import { isBooksWorkspaceEnabled } from "@/lib/services/books/module";

/** Optional accounting controls embedded in otherwise provider-neutral workflows. */
export const getBooksUiAccess = cache(async () => {
  const context = await requireOrgContext();
  if (!(await isBooksWorkspaceEnabled(context.orgId)))
    return { read: false, adjust: false, manage: false };
  const permissions = ["books.read", "books.adjust", "books.manage"] as const;
  const decisions = await Promise.all(
    permissions.map((permission) =>
      authorize({
        permission,
        userId: context.userId,
        orgId: context.orgId,
        supabase: context.supabase,
        logDecision: false,
      }),
    ),
  );
  const allowed = decisions.map(
    (decision) => decision.allowed && decision.divisionScope !== "assigned",
  );
  return {
    read: allowed[0],
    adjust: allowed[0] && allowed[1],
    manage: allowed[0] && allowed[2],
  };
});
