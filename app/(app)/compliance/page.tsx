import { PageLayout } from "@/components/layout/page-layout"
import { listCompanies } from "@/lib/services/companies"
import { getComplianceRules } from "@/lib/services/compliance"
import { ComplianceDashboard } from "@/components/compliance/compliance-dashboard"
import { requireOrgContext } from "@/lib/services/context"

export const dynamic = "force-dynamic" // Required for authenticated user data that can't be statically generated

export default async function CompliancePage() {
  try {
    const context = await requireOrgContext()

    const [companies, rules] = await Promise.all([
      listCompanies(undefined, context).catch(() => []),
      getComplianceRules().catch(() => ({
        require_w9: true,
        require_insurance: true,
        require_license: false,
        require_lien_waiver: false,
        block_payment_on_missing_docs: true,
      })),
    ])

    return (
      <PageLayout title="Compliance">
        <div className="space-y-6">
          <ComplianceDashboard companies={companies} rules={rules} />
        </div>
      </PageLayout>
    )
  } catch (error) {
    // Handle unauthenticated users gracefully
    return (
      <PageLayout title="Compliance">
        <div className="space-y-6">
          <div className="text-center py-8">
            <p className="text-muted-foreground">Please sign in to view compliance information.</p>
          </div>
        </div>
      </PageLayout>
    )
  }
}
