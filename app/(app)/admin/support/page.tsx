import { AdminLoadingSkeleton } from "@/components/admin/admin-loading-skeleton"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { SupportContractsTable } from "@/components/admin/support-contracts-table"
import { ImpersonationSheet } from "@/components/platform/impersonation-sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { listPlatformOrganizations } from "@/lib/services/platform-access"
import { getPlatformSessionState } from "@/lib/services/platform-session"


/**
 * Impersonation lives here rather than on the Platform index because this is the
 * support desk: an audited "see what the customer sees" session is a support
 * action, and the person reaching for it is already looking at the contract.
 */
async function ImpersonationLauncher() {
  const [orgs, session] = await Promise.all([listPlatformOrganizations(), getPlatformSessionState()])

  return (
    <ImpersonationSheet
      orgs={orgs.map((org) => ({ id: org.id, name: org.name }))}
      session={{
        active: session.impersonation.active,
        target: session.impersonation.targetName ?? session.impersonation.targetEmail,
        expiresAt: session.impersonation.expiresAt,
      }}
    />
  )
}

async function SupportPageContent() {
  await requireAnyPermissionGuard(["billing.manage", "platform.support.read"])

  return (
    <PageLayout
      title="Support Contracts"
      breadcrumbs={[
        { label: "Admin", href: "/admin" },
        { label: "Support Contracts" },
      ]}
    >
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3 border-b pb-3">
          <p className="text-sm text-muted-foreground">Support agreements and diagnostic access.</p>
          <Suspense fallback={<Skeleton className="h-8 w-32" />}>
            <ImpersonationLauncher />
          </Suspense>
        </div>
        <Suspense fallback={<SupportTableSkeleton />}>
          <SupportContractsTable />
        </Suspense>
      </div>
    </PageLayout>
  )
}

function SupportTableSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  )
}

export default function SupportPage() {
  return (
    <Suspense fallback={<AdminLoadingSkeleton />}>
      <SupportPageContent />
    </Suspense>
  )
}
