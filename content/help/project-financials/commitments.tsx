import Link from "next/link"

export default function CommitmentsArticle() {
  return (
    <>
      <p>
        Commitments represent contracted project costs issued to subcontractors and trade partners, such as 
        <strong>Subcontracts</strong> and <strong>Purchase Orders</strong>. Commitments lock in subcontractor pricing, 
        control progress billing, and manage retainage.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Contract Mapping:</strong> Issue subcontracts to vendor companies, mapping lines to project cost codes.</li>
        <li><strong>Progressive Billing Control:</strong> Subcontractors bill against their commitment line items, preventing overbilling.</li>
        <li><strong>Retainage Withholding:</strong> Automate withholding percentages (e.g., 5% or 10%) on progressive subcontractor invoices.</li>
        <li><strong>Commitment Change Orders:</strong> Adjust commitment totals via Subcontractor Change Orders (SCOs) to maintain contract integrity.</li>
      </ul>

      <h2>Billing Mode Integration</h2>
      <p>
        Commitments function as the bridge between your subcontractor costs and your client billing:
      </p>

      <h3>Fixed Price billing</h3>
      <p>
        In Fixed Price contracts, commitments represent the buy-out of your budget. If you buy out a cost code 
        for less than the budget baseline, you lock in a positive variance (under-run), increasing project profit margin.
      </p>

      <h3>Cost-Plus billing</h3>
      <p>
        In Cost-Plus, GMP, or Time &amp; Materials billing, subcontractor invoices billed against commitments 
        are processed as actual costs.
      </p>
      <ul>
        <li><strong>Review Queue:</strong> Once a subcontractor bill is approved, the amount flows into the client billing review queue.</li>
        <li><strong>Open Book Transparency:</strong> The contract value, subcontracts, and progressive invoices are visible in the Client Portal if Open Book is enabled.</li>
      </ul>

      <h2>Retainage Withholding and Release</h2>
      <p>
        Retainage is a portion of the subcontract value withheld until work is completed satisfactorily.
      </p>
      <ol>
        <li><strong>Setup:</strong> Define a default retainage percentage (e.g., 10%) when creating a commitment.</li>
        <li><strong>Withholding:</strong> When a subcontractor submits a progress bill for $10,000, Arc automatically calculates and withholds $1,000, setting the net payable to $9,000.</li>
        <li><strong>Retention Tracking:</strong> Arc logs the accumulated withheld balance.</li>
        <li><strong>Release:</strong> At project closeout, create a final bill to release the accumulated retainage balance.</li>
      </ol>
    </>
  )
}
