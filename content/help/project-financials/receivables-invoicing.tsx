import Link from "next/link"

export default function ReceivablesInvoicingArticle() {
  return (
    <>
      <p>
        The Receivables &amp; Invoicing tool manages billing your clients. It supports progress billing, 
        billing periods, retainage holding, QuickBooks Online sync, and online card/ACH payments via Stripe.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Billing Periods:</strong> Set up monthly or phase-based billing periods to group invoices.</li>
        <li><strong>Progress Billing:</strong> Invoice clients based on percentage of completion for each cost code.</li>
        <li><strong>Retainage Hold &amp; Release:</strong> Hold client retainage on progress invoices and release the held balances at project closeout.</li>
        <li><strong>QuickBooks Online Sync:</strong> Push client invoices to QuickBooks to record income and manage receivables.</li>
        <li><strong>Client Portals &amp; Stripe:</strong> Clients receive secure, passwordless portal links where they can view invoices, download backup receipts, and pay online.</li>
      </ul>

      <h2>Progress Billing vs. Cost-Plus Draws</h2>
      <p>
        How you invoice your client depends entirely on your project&apos;s <strong>Billing Mode</strong>:
      </p>

      <h3>Fixed Price (Progress Billing)</h3>
      <p>
        For Fixed Price projects, invoicing is based on a **Schedule of Values (SOV)**:
      </p>
      <ul>
        <li>The SOV splits the contract value into cost code lines.</li>
        <li>For each billing period, you input the percentage of work completed (e.g., 50% of Foundation, 10% of Framing).</li>
        <li>Arc calculates the invoiced amounts based on these completion percentages. No transaction receipts or bills are shown to the client.</li>
      </ul>

      <h3>Cost-Plus / Time &amp; Materials (Draws)</h3>
      <p>
        For Cost-Plus (Percent, Fixed Fee, or GMP) and T&amp;M projects, invoicing is based on actual expenditures:
      </p>
      <ul>
        <li>Arc compiles all approved, billable transactions (vendor bills, timesheets, expenses) from the billing period.</li>
        <li>You review these actual costs, apply markups or builder fees, and compile them into a <strong>Draw Invoice</strong>.</li>
        <li><strong>Open Book:</strong> If <em>Open Book Required</em> is enabled, the client can view detailed transaction-level receipts, subcontractor bills, and timesheets directly inside their Client Portal as supporting documentation.</li>
      </ul>

      <h2>Client Retainage</h2>
      <p>
        Retainage is a portion of the progress invoice amount withheld by the client until project completion.
      </p>
      <ul>
        <li><strong>Withholding:</strong> Define a retainage percentage (e.g., 5% or 10%) in your project financial settings. Arc automatically subtracts this from progress billings.</li>
        <li><strong>Tracking:</strong> Net invoices reflect the billing total minus retainage, while Arc tracks the accumulated held balance.</li>
        <li><strong>Release:</strong> At closeout, generate a final invoice to release the accumulated retainage balance.</li>
      </ul>

      <h2>Client Portal, Stripe Payments, &amp; QuickBooks Online Sync</h2>
      <p>
        Once you approve a client invoice in Arc:
      </p>
      <ol>
        <li><strong>Send Invoice:</strong> Click <strong>Send Invoice</strong>. Arc emails the client a secure link.</li>
        <li><strong>Client Portal:</strong> The client clicks the link to open their secure portal. They can review invoice lines, check open-book receipts, and download PDF copies.</li>
        <li><strong>Stripe Payments:</strong> Clients can pay securely inside their portal using Credit Card or ACH (direct bank transfer). Once payment is processed, Arc automatically updates the invoice status to <strong>Paid</strong>.</li>
        <li><strong>QuickBooks Sync:</strong> Push the invoice to QuickBooks Online. When the client payment is recorded, QuickBooks syncs the paid status back to Arc.</li>
      </ol>
    </>
  )
}
