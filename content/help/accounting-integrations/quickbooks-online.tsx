import Link from "next/link"

export default function QuickBooksOnlineArticle() {
  return (
    <>
      <p>
        Connecting Arc to QuickBooks Online (QBO) synchronizes your project financials with your general ledger. 
        It automates the creation of bills and invoices in QuickBooks, maps vendors and customers, and syncs payments 
        back to Arc.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Customer &amp; Job Mapping:</strong> Link Arc projects to QuickBooks Customers or Sub-Customers (Jobs).</li>
        <li><strong>Vendor Mapping:</strong> Link Directory companies to QuickBooks Vendors to keep payables aligned.</li>
        <li><strong>Bill Sync (Payables):</strong> Push approved subcontractor bills and material purchases to QuickBooks, complete with GL expense coding.</li>
        <li><strong>Invoice Sync (Receivables):</strong> Push client progress invoices to QuickBooks as QBO Invoices, mapped to QBO income accounts.</li>
        <li><strong>Payment Sync:</strong> Once a bill or invoice is paid in QuickBooks, the payment status, reference number, and date sync back to Arc automatically.</li>
        <li><strong>Data Import:</strong> Import existing QuickBooks customers, vendors, and GL accounts directly into Arc during setup.</li>
      </ul>

      <h2>Linking Records</h2>
      <p>
        For a clean sync, you must link your records after connecting QuickBooks under <strong>Settings → Integrations</strong>:
      </p>
      <ul>
        <li><strong>Projects:</strong> Open a project, go to financial setup, and select the corresponding QuickBooks Customer or Job.</li>
        <li><strong>Vendors:</strong> Open a Directory company and link them to their QuickBooks Vendor profile. This ensures bills are posted to the correct accounts.</li>
      </ul>

      <h2>Billing and Invoice Sync Workflows</h2>
      <p>
        Once linked, financial records sync dynamically:
      </p>
      
      <h3>Syncing subcontractor bills</h3>
      <p>
        When you approve a subcontractor bill in Arc, click <strong>Sync to QuickBooks</strong>. Arc creates a Bill in 
        QuickBooks. When your accountant cuts a check or sends a bank payment in QuickBooks, QBO pushes a payment 
        confirmation back to Arc, updating the bill status to <strong>Paid</strong>.
      </p>

      <h3>Syncing client invoices</h3>
      <p>
        When you approve a client invoice (draw or progress bill), sync it to QuickBooks. Arc creates an Invoice in QBO. 
        When you record the payment in QuickBooks, the invoice in Arc updates to <strong>Paid</strong>.
      </p>
    </>
  )
}
