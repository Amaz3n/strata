import Link from "next/link"

export default function ChangeOrdersArticle() {
  return (
    <>
      <p>
        Change Orders record adjustments to a project&apos;s scope, contract value, timeline, or commitment amounts. 
        Arc handles both client-side changes and subcontractor-side changes, keeping budgets and contracts aligned.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Owner Change Orders (OCO):</strong> Adjust the contract sum, GMP cap, or fixed fees with the client.</li>
        <li><strong>Subcontractor Change Orders (SCO):</strong> Adjust subcontract commitment values and scope with trade partners.</li>
        <li><strong>Timeline Day Impacts:</strong> Add or subtract schedule days, automatically updating forecasted completion dates.</li>
        <li><strong>Markup &amp; Tax:</strong> Define custom markups (builder fees) and tax rates to automate financial totals.</li>
        <li><strong>Budget Postings:</strong> Approved change orders automatically update original budget baselines and cost code lines.</li>
      </ul>

      <h2>OCO vs. SCO Workflows</h2>
      <p>
        Arc separates client-facing modifications from subcontractor modifications to manage risk:
      </p>
      
      <h3>Owner Change Orders (OCO)</h3>
      <p>
        These adjust your contract with the client.
      </p>
      <ul>
        <li><strong>Fixed Price:</strong> OCOs increase the total contract sum the client owes.</li>
        <li><strong>Cost-Plus with GMP:</strong> OCOs adjust the Guaranteed Maximum Price cap (<code>gmpCents</code>) or the Fixed Fee (<code>fixedFeeCents</code>) rather than a simple contract sum, preventing cost-plus actuals from hitting a locked ceiling.</li>
        <li><strong>Client Visibility:</strong> OCOs can be marked as client-visible, allowing clients to review and sign them in their portal.</li>
      </ul>

      <h3>Subcontractor Change Orders (SCO)</h3>
      <p>
        These adjust subcontracts. When a subcontractor scope changes:
      </p>
      <ul>
        <li>Create an SCO linked to their existing <strong>Commitment</strong>.</li>
        <li>Add lines specifying cost codes and descriptions.</li>
        <li>Once approved, the SCO increases the subcontractor&apos;s billing limit, allowing them to submit progress invoices for the new amount.</li>
      </ul>

      <h2>Financial Calculations and GMP Impacts</h2>
      <p>
        When drafting a change order, add cost lines. Arc automatically compiles:
      </p>
      <ul>
        <li><strong>Subtotal:</strong> The sum of all itemized lines.</li>
        <li><strong>Markup:</strong> Applied as a percentage (e.g., 10% overhead &amp; profit builder fee).</li>
        <li><strong>Tax:</strong> Applied to lines marked as taxable.</li>
        <li><strong>Total:</strong> The net contract adjustment.</li>
      </ul>
      <p>
        In GMP projects, lines are classified as <strong>Inside GMP</strong> or <strong>Outside GMP</strong>, determining 
        whether the change order shifts the Guaranteed Maximum Price limit.
      </p>

      <h2>Approvals and Budget Posting</h2>
      <p>
        Change orders start as <strong>Draft</strong> or <strong>Pending</strong>. You can send them for electronic signature 
        using the integrated **Signatures** tool. 
      </p>
      <p>
        Once approved:
      </p>
      <ol>
        <li>The status updates to <strong>Approved</strong>.</li>
        <li>The OCO posts a budget revision, updating your budget columns.</li>
        <li>The SCO updates the commitment value, increasing the subcontractor&apos;s billing cap.</li>
      </ol>
    </>
  )
}
