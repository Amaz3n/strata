import Link from "next/link"

export default function PayablesArticle() {
  return (
    <>
      <p>
        The Payables tool manages subcontractor invoices and vendor bills. It streamlines cost coding, 
        internal approval workflows, compliance tracking, payment execution, and QuickBooks Online synchronization.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Cost Inbox:</strong> A central drag-and-drop landing queue for incoming vendor PDFs and files.</li>
        <li><strong>Commitment Matching:</strong> Link bills to subcontracts, ensuring progress billing matches contract lines.</li>
        <li><strong>Insurance &amp; Lien Waiver Compliance:</strong> Prevent payments if insurance has expired or if signed lien waivers are missing.</li>
        <li><strong>QuickBooks Sync:</strong> Sync approved bills and payment details directly with QuickBooks Online.</li>
        <li><strong>Billing Integration Controls:</strong> Manage how bills flow into client invoices based on project billing rules.</li>
      </ul>

      <h2>The Cost Inbox and Bill Coding</h2>
      <p>
        The <strong>Cost Inbox</strong> acts as a digital mailroom. Project teams can drag and drop bill PDFs or 
        forward vendor emails to a custom inbox address. From the inbox, you can review the document and fill in 
        vendor names, bill numbers, dates, and cost codes to create an official vendor bill.
      </p>

      <h2>Compliance and Risk Management</h2>
      <p>
        Before a bill is marked as ready for payment, Arc checks subcontractor compliance rules:
      </p>
      <ul>
        <li><strong>Lien Waivers:</strong> Track the receipt of Conditional and Unconditional Lien Waivers. Arc can hold payments until waivers are uploaded.</li>
        <li><strong>Insurance:</strong> View real-time alerts if a subcontractor&apos;s liability or workers&apos; comp insurance listed in the Directory is expired.</li>
      </ul>

      <h2>Billing Rules for Client Draws</h2>
      <p>
        In Cost-Plus, GMP, and Time &amp; Materials projects, vendor bills represent actual costs that are passed 
        through to client invoices. Arc enforces specific rules to control this flow:
      </p>
      
      <h3>Paid Costs Required</h3>
      <p>
        If <strong>Paid Costs Required</strong> is enabled in your project settings, a vendor bill will <em>not</em> 
        appear in the client review queue for billing until you have paid the vendor and recorded the transaction. 
        This prevents general contractors from billing clients for subcontractor work they have not yet funded.
      </p>

      <h3>Proof Required</h3>
      <p>
        If <strong>Proof Required</strong> is enabled, bills must have an attached invoice PDF or receipt file 
        associated with them before they can be pulled into a client draw.
      </p>

      <h3>Client Cost Approval Required</h3>
      <p>
        If <strong>Client Cost Approval Required</strong> is enabled, the client must log into their portal and 
        formally approve the actual cost line items in their queue before the builder can generate the final invoice 
        reimbursing those costs.
      </p>

      <h2>Accounting Sync (QuickBooks Online)</h2>
      <p>
        When you approve a vendor bill, you can sync it directly to QuickBooks Online. Arc maps the project vendor 
        and cost codes to QuickBooks vendor records and GL expense accounts. Once a check or ACH payment is recorded 
        in QuickBooks, the payment reference and paid status automatically sync back to Arc.
      </p>
    </>
  )
}
