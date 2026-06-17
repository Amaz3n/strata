import Link from "next/link"

export default function ProjectFinancialsOverviewArticle() {
  return (
    <>
      <p>
        Project Financials provides general contractors and builders with tools to manage budgets, subcontracts, 
        vendor payables, ad-hoc expenses, contract changes, and client invoices. Maintaining integrated financial 
        data ensures real-time forecasting and job costing accuracy.
      </p>

      <h2>Core Modules in Project Financials</h2>
      <p>
        Project Financials includes six integrated modules. Click the detailed guides below to learn how to manage 
        each workflow:
      </p>

      <h3>1. Budget</h3>
      <p>
        Organize estimated project costs using cost codes, draft and lock budget versions, and track real-time original 
        vs. revised budget balances against actual expenditures.
        {" "}
        <Link href="/help/project-financials/financial-workflows/budget">
          Read the Budget Guide
        </Link>
        .
      </p>

      <h3>2. Commitments</h3>
      <p>
        Log subcontracts and purchase orders, specify line-item costs, automate subcontractor retainage percentages, 
        and track progress billing milestones.
        {" "}
        <Link href="/help/project-financials/financial-workflows/commitments">
          Read the Commitments Guide
        </Link>
        .
      </p>

      <h3>3. Payables</h3>
      <p>
        Manage subcontractor bills via the Cost Inbox, route bills for approval, track lien waiver and insurance compliance, 
        and sync payables directly with QuickBooks Online.
        {" "}
        <Link href="/help/project-financials/financial-workflows/payables">
          Read the Payables Guide
        </Link>
        .
      </p>

      <h3>4. Expenses &amp; Time</h3>
      <p>
        Log out-of-pocket credit card expenditures, use AI to extract receipt details, track labor time sheets, 
        and compile billable costs for cost-plus client draws.
        {" "}
        <Link href="/help/project-financials/financial-workflows/expenses-time">
          Read the Expenses &amp; Time Guide
        </Link>
        .
      </p>

      <h3>5. Change Orders</h3>
      <p>
        Manage scope variations via Owner Change Orders (OCO) and Subcontractor Change Orders (SCO), calculating tax/markup, 
        tracking timeline impacts, and revising budgets.
        {" "}
        <Link href="/help/project-financials/financial-workflows/change-orders">
          Read the Change Orders Guide
        </Link>
        .
      </p>

      <h3>6. Receivables &amp; Invoices</h3>
      <p>
        Create client progress invoices by billing period, track client retainage holdings, sync invoices with QuickBooks, 
        and collect card or ACH payments online.
        {" "}
        <Link href="/help/project-financials/financial-workflows/receivables-invoicing">
          Read the Receivables &amp; Invoices Guide
        </Link>
        .
      </p>
    </>
  )
}
