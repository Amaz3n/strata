import Link from "next/link"

export default function SubscriptionBillingArticle() {
  return (
    <>
      <p>
        The Subscription &amp; Billing settings panel allows Workspace Administrators to update payment methods, 
        download historical invoices, and review the status of external integrations. Arc uses secure integrations with 
        Stripe for payment processing and QuickBooks Online for accounting synchronization.
      </p>

      <h2>Stripe Customer Billing Portal</h2>
      <p>
        Arc partners with Stripe to provide a self-service customer portal. To access the portal, navigate to 
        <strong>Settings → Billing</strong> and click <strong>Manage Billing Portal</strong>. Inside the Stripe portal, you can:
      </p>
      <ul>
        <li>
          <strong>Update Payment Methods:</strong> Replace expired business credit cards, add backup credit cards, or switch to direct bank debit if supported.
        </li>
        <li>
          <strong>Edit Billing Information:</strong> Update your company legal name, corporate billing address, billing contact email address, 
          and business Tax ID (EIN). These details automatically update on all subsequent receipts.
        </li>
        <li>
          <strong>Invoice &amp; Receipt History:</strong> Access, view, and download PDF receipts and official invoices for every transaction since your account was created.
        </li>
      </ul>

      <h2>Integrated Services Settings</h2>
      <p>
        Workspace Administrators configure and monitor system-wide integrations under <strong>Settings → Integrations</strong>.
      </p>

      <h3>1. QuickBooks Online Sync Status</h3>
      <p>
        Manage the configuration rules that sync financial data between Arc and QBO:
      </p>
      <ul>
        <li><strong>Connection Status:</strong> View connection health and re-authenticate when the token expires (typically every 100 days).</li>
        <li><strong>Mapping Accounts:</strong> Select standard QBO accounts for cost sync, including mapping default Accounts Payable (A/P) accounts for vendor bills and Accounts Receivable (A/R) for client invoices.</li>
        <li><strong>Tax Code Mapping:</strong> Map Arc cost codes to corresponding QuickBooks Chart of Accounts items or Products &amp; Services.</li>
      </ul>

      <h3>2. Stripe Merchant Payments Onboarding</h3>
      <p>
        Allows your organization to receive credit card and ACH payments directly from clients via the Client and Bid Portals:
      </p>
      <ul>
        <li><strong>Stripe Express Setup:</strong> Click <strong>Connect Stripe</strong> to complete merchant onboarding. You will be redirected to Stripe to input your business bank routing/account numbers, business registry information, and verify representative identity.</li>
        <li><strong>Payout Configuration:</strong> Choose between daily automated payouts or manual payouts of received funds to your corporate checking account.</li>
        <li><strong>Fee Allocation:</strong> Review processing fees for credit card swipes and ACH transfers, and decide whether to absorb fees or pass credit card processing fees onto the paying client.</li>
      </ul>
    </>
  )
}
