import Link from "next/link"

export default function IntegrationsOverviewArticle() {
  return (
    <>
      <p>
        Integrations connect your Arc workspace directly to external accounting and payment systems. By linking 
        these services, you eliminate double data entry, automate invoice payment tracking, and keep your general 
        ledger up to date.
      </p>

      <h2>Supported Integrations</h2>
      <p>
        Arc integrates with two primary financial services. Click the detailed guides below to learn how to set up 
        and manage each service:
      </p>

      <h3>1. QuickBooks Online</h3>
      <p>
        Synchronize customers, vendors, approved subcontractor bills, and client progress invoices. Automatically 
        pull payment statuses from your QuickBooks ledger back into your Arc dashboards.
        {" "}
        <Link href="/help/accounting-and-integrations/connected-services/quickbooks-online">
          Read the QuickBooks Online Guide
        </Link>
        .
      </p>

      <h3>2. Stripe Payments</h3>
      <p>
        Enable online invoice billing, accept credit cards or secure ACH bank transfers directly inside the Client 
        Portal, and set up automatic bank payouts.
        {" "}
        <Link href="/help/accounting-and-integrations/connected-services/stripe-payments">
          Read the Stripe Payments Guide
        </Link>
        .
      </p>

      <h2>Enabling Integrations</h2>
      <p>
        To connect these services, navigate to <strong>Settings → Integrations</strong>. Connection setup 
        typically requires Administrator permissions in both Arc and the corresponding target platform.
      </p>
    </>
  )
}
