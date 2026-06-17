import Link from "next/link"

export default function ExpensesTimeArticle() {
  return (
    <>
      <p>
        The Expenses &amp; Time tool tracks non-contractual project costs. This includes out-of-pocket expenditures, 
        field purchases, employee receipts, fuel cards, and labor timesheets. These records populate your actual 
        costs and drive client invoicing in Cost-Plus and Time &amp; Materials billing.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>AI Receipt Scanner:</strong> Upload photos or PDFs of receipts, and Arc automatically extracts the vendor name, date, payment method, and amount.</li>
        <li><strong>Labor Timesheets:</strong> Log hours for internal crew members, coded to specific project cost codes.</li>
        <li><strong>Labor Burden Multipliers:</strong> Apply labor multipliers to calculate the fully burdened labor cost passed to the client.</li>
        <li><strong>Builder Fee Markups:</strong> Automatically apply markup percentages to actual costs when billing the client.</li>
      </ul>

      <h2>Ad-Hoc Expenses and AI Scan</h2>
      <p>
        To log site purchases, navigate to the <strong>Expenses</strong> section under your project financials and click <strong>New Expense</strong>.
      </p>
      <ol>
        <li>Drag and drop a receipt file into the upload zone.</li>
        <li>Arc&apos;s AI engine scans the receipt to extract the transaction details, pre-filling the expense form.</li>
        <li>Select the project <strong>Cost Code</strong> and verify the payment method (e.g., Credit Card, Cash, Check).</li>
      </ol>
      <blockquote>
        <strong>Tip:</strong> AI receipt scanning works on both mobile and desktop, making it easy for superintendents to snap photos of receipts on-site and log them immediately.
      </blockquote>

      <h2>Labor Hours and Burden Multiplier</h2>
      <p>
        Track internal crew hours in the **Time** section. You can log hours worked by date, crew member, and cost code.
      </p>
      <p>
        In Cost-Plus and Time &amp; Materials billing, labor costs often include overhead burden (taxes, benefits, insurance). 
        Arc manages this with the <strong>Labor Burden Multiplier</strong> defined in your project settings:
      </p>
      <blockquote>
        <strong>Example:</strong> If a carpenter&apos;s base hourly rate is $30/hr and your project settings apply a 
        Labor Burden Multiplier of 1.35, Arc calculates the fully burdened billable labor rate as $40.50/hr ($30 * 1.35), 
        which is what will be invoiced to the client.
      </blockquote>

      <h2>Cost-Plus Billing and Markups</h2>
      <p>
        In Cost-Plus projects, expenses and timesheet entries marked as <strong>Billable</strong> flow directly 
        into the client billing review queue.
      </p>
      <ul>
        <li><strong>Markup Percentages:</strong> Define a default markup percentage (e.g., 10%) in your financial setup. When actual costs are billed, Arc automatically appends the 10% fee.</li>
        <li><strong>Receipt Proof:</strong> When generating a client invoice, Arc compiles all uploaded receipt attachments into a single backup package. If <strong>Open Book Required</strong> is enabled, clients can click to view these receipts directly inside their Client Portal.</li>
      </ul>
    </>
  )
}
