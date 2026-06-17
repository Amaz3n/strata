import Link from "next/link"

export default function BidProposalPortalsArticle() {
  return (
    <>
      <p>
        In addition to full project portals, Arc provides focused, task-specific landing pages for 
        preconstruction bidding, contract proposals, and client invoice payments. These secure portals let 
        subcontractors and clients execute key tasks without needing a full Arc account.
      </p>

      <h2>Core Single-Task Portals</h2>
      <p>
        Arc utilizes three main single-purpose portal experiences:
      </p>

      <h3>1. The Subcontractor Bid Portal</h3>
      <p>
        When you invite a trade partner to bid on a project or preconstruction package, they receive a secure email link. 
        Opening this link loads the <strong>Bid Portal</strong>:
      </p>
      <ul>
        <li><strong>Document Distribution:</strong> Bidders download bid specifications, packages, and drawings.</li>
        <li><strong>Addenda Updates:</strong> If you issue addenda, the portal updates instantly, displaying alerts and new files. Arc tracks which bidders have viewed these updates.</li>
        <li><strong>Bid Submission:</strong> Bidders upload their proposal files and input their bid totals, currency, exclusions, clarifications, lead times, and notes.</li>
      </ul>

      <h3>2. The Proposal and Contract Signing Portal</h3>
      <p>
        When you deliver a preconstruction proposal to a client, they are directed to the <strong>Proposal Portal</strong>:
      </p>
      <ul>
        <li><strong>Pricing Customization:</strong> Clients review estimate cost breakdowns. If you included <strong>Optional Add-Ons</strong> (upgrades), clients can toggle checkboxes to select or deselect items, adjusting the contract total in real-time.</li>
        <li><strong>Terms &amp; Conditions:</strong> Review the project contract terms, payment schedules, and legal fine print.</li>
        <li><strong>Electronic Signature:</strong> If signature is required, clients execute the contract directly inside their browser, which automatically promotes the prospect, creates the project, and locks in the budget and contract schedule of values.</li>
      </ul>

      <h3>3. The Client Invoice &amp; Receipt Portal</h3>
      <p>
        When you send a progress invoice, the client receives a secure billing link loading the <strong>Invoice Portal</strong>:
      </p>
      <ul>
        <li><strong>Invoice Details:</strong> Clients view outstanding balances, payment due dates, and itemized billing details.</li>
        <li><strong>Open Book Backups:</strong> If enabled, the portal displays client-visible receipts, timesheets, and vendor bill photos backing up the invoice totals.</li>
        <li><strong>Stripe Payments:</strong> Clients pay securely using credit card or ACH. When completed, the portal displays a receipt, and Arc updates your financials.</li>
      </ul>

      <h2>Security and Token Access</h2>
      <p>
        Single-task portals are designed for frictionless use:
      </p>
      <ul>
        <li><strong>Secure Tokens:</strong> Access is controlled by secure, cryptographically hashed tokens embedded in the email links, keeping documents safe without requiring passwords.</li>
        <li><strong>PIN Options:</strong> For extra security on sensitive proposals or invoices, builders can enable a 4-digit PIN check required before access is granted.</li>
      </ul>
    </>
  )
}
