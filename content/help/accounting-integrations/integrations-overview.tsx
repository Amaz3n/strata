import Link from "next/link"

export default function IntegrationsOverviewArticle() {
  return (
    <>
      <p>
        Integrations connect Arc workflows to accounting and payment services. Organization
        administrator access is generally required to connect or change them.
      </p>
      <h2>QuickBooks Online</h2>
      <p>
        QuickBooks integration supports connected accounting workflows such as customers,
        vendors, invoices, bills, payments, expenses, account coding, imports, and sync
        history.
      </p>
      <h2>Stripe</h2>
      <p>
        Stripe supports Arc payment and payout features when the organization has completed
        the required onboarding and account verification.
      </p>
      <h2>Manage integrations</h2>
      <p>
        Open <Link href="/settings?tab=integrations">Settings → Integrations</Link> to
        review connection status and available configuration.
      </p>
      <h2>Before syncing</h2>
      <p>
        Confirm that projects, companies, customers, vendors, and accounting categories are
        linked correctly. Review failed or pending records before retrying a sync.
      </p>
    </>
  )
}
