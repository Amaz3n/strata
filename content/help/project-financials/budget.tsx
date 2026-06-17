import Link from "next/link"

export default function BudgetArticle() {
  return (
    <>
      <p>
        The Budget tool in Arc is the financial foundation of your project. It defines your cost baseline, 
        organizes expected costs using cost codes, and tracks real-time commitment and actual cost values. 
        How the budget behaves depends on your project&apos;s <strong>Billing Mode</strong>.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Cost Code Structure:</strong> Enforce organization by standard CSI divisions or custom company cost codes.</li>
        <li><strong>Budget Lines:</strong> Detail estimated amounts, quantities, units, and descriptions for each cost code.</li>
        <li><strong>Version Control:</strong> Keep multiple budget drafts, save version history, and lock your approved baseline.</li>
        <li><strong>Real-Time Actuals:</strong> Automatically compiles subcontracts, purchase orders, vendor bills, and timesheets against corresponding cost codes.</li>
      </ul>

      <h2>Working Without Cost Codes</h2>
      <p>
        Not every builder uses formal cost codes. You can turn them off per project in <strong>Project Settings</strong>.
        When cost codes are disabled, the <strong>budget line itself becomes the cost bucket</strong>: add one line per
        part of the job (e.g. Framing, Plumbing, Allowances) with the amount you expect to spend.
      </p>
      <ul>
        <li><strong>Tagging costs:</strong> When you enter an expense or vendor bill, a <em>Budget line</em> picker replaces the cost-code picker. Pick the line a cost belongs to and it rolls into that line&apos;s Committed/Actual columns.</li>
        <li><strong>Unassigned:</strong> Costs (or imported items) left without a budget line collect in an <em>Unassigned</em> row. Re-open the expense or bill and choose a line to attribute it.</li>
        <li><strong>Commitments:</strong> Subcontracts and POs created from a budget line are tied to that line automatically.</li>
      </ul>

      <h2>Billing Mode Interactions</h2>
      <p>
        Budgets serve different business purposes depending on the project&apos;s contract type:
      </p>

      <h3>Fixed Price (Lump Sum)</h3>
      <p>
        In a Fixed Price project, your contract with the client is for a set amount. The budget acts as your internal 
        cost plan. 
      </p>
      <ul>
        <li><strong>Margin Tracking:</strong> The variance between your Revised Budget and your Actual Cost is your direct profit margin.</li>
        <li><strong>Slippage:</strong> Cost overruns reduce your company&apos;s profit margin, while cost savings directly increase it.</li>
      </ul>

      <h3>Cost-Plus (Percent or Fixed Fee)</h3>
      <p>
        In Cost-Plus billing, the client pays for actual documented project costs plus a builder markup or flat fee.
      </p>
      <ul>
        <li><strong>Estimate Comparison:</strong> The budget acts as a cost estimate. Client invoices are compiled from actual costs, not the budget, but the budget acts as a reference to keep the client informed.</li>
        <li><strong>Open Book:</strong> Clients can view the budget lines side-by-side with actual expenditures in their portal.</li>
      </ul>

      <h3>Guaranteed Maximum Price (GMP)</h3>
      <p>
        Cost-Plus with a GMP sets a cap on what the client will pay.
      </p>
      <ul>
        <li><strong>Hard Cap:</strong> Overruns exceeding the GMP are absorbed entirely by the builder.</li>
        <li><strong>Savings Split:</strong> If actual costs are below the GMP, the remaining funds are split between the Owner and Builder according to the project&apos;s <em>Savings Split</em> percentages (e.g., 60% to Owner, 40% to Builder).</li>
      </ul>

      <h2>A Living Document</h2>
      <p>
        The budget is editable at any time and updates your project forecast continuously — add, edit, or remove
        lines as the job evolves. The first amounts you enter become the <strong>Original</strong> baseline; approved
        Change Orders flow into the <strong>Approved CO</strong> column, and the two combine into your <strong>Revised</strong>
        budget. Committed, Actual, and the EAC/VAC forecast columns recompute automatically as costs come in.
      </p>
    </>
  )
}
