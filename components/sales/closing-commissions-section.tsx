import { ClosingCommissions, ClosingCommissionsError } from "@/components/sales/closing-commissions"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"
import { getClosingCommissions } from "@/lib/services/sales-commissions"

/**
 * Server loader for the closing workbench's commission band. Render it inside
 * `<Suspense fallback={<ClosingCommissionsSkeleton />}>` and pass it to the
 * workbench as a slot.
 */
export async function ClosingCommissionsSection({ projectId }: { projectId: string }) {
  const loaded = await loadClosingCommissions(projectId)
  if (!loaded.ok) return <ClosingCommissionsError message={loaded.error} />
  return <ClosingCommissions projectId={projectId} view={loaded.view} canMarkPayrollPaid={loaded.canMarkPayrollPaid} />
}

async function loadClosingCommissions(projectId: string) {
  try {
    const context = await requireOrgContext()
    const [view, canMarkPayrollPaid] = await Promise.all([
      getClosingCommissions(projectId, context.orgId),
      hasPermission("payment.release", { orgId: context.orgId, userId: context.userId, supabase: context.supabase }),
    ])
    return { ok: true as const, view, canMarkPayrollPaid }
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "Commissions could not be loaded." }
  }
}
