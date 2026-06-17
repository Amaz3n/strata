import Link from "next/link"

export default function SubcontractorPortalArticle() {
  return (
    <>
      <p>
        The Subcontractor Portal gives trade partners a secure, private dashboard to view subcontracts, submit 
        progress bills, upload compliance certificates, respond to RFIs, and resolve assigned punch items.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Commitment Reviews:</strong> Subcontractors review their active subcontracts, payment histories, and scopes of work.</li>
        <li><strong>Progress Billing:</strong> Trade partners submit monthly bills by entering their completion percentages against subcontract lines.</li>
        <li><strong>Compliance Uploads:</strong> Subcontractors upload renewed General Liability, Workers&apos; Comp certificates, and W-9s directly.</li>
        <li><strong>RFI &amp; Submittal Collaboration:</strong> Answer assigned project RFIs and submit shop drawings or product files.</li>
        <li><strong>Punch Resolution:</strong> View assigned deficiency items, upload completion photos, and mark punch list items as resolved.</li>
      </ul>

      <h2>Inviting Subcontractors</h2>
      <p>
        To grant portal access, open a subcontractor company record in your project Directory, click <strong>Invite Subcontractors</strong>, 
        and select the contacts who should receive access. 
      </p>
      <p>
        Each contact receives a secure token-based link. When they log in, Arc verifies their company affiliation 
        and groups all active contracts, RFIs, and punch items under their company portal dashboard.
      </p>

      <h2>Subcontractor Portal Workflows</h2>
      <p>
        Inside their dashboard, trade partners can complete several core actions:
      </p>

      <h3>1. Submitting progress bills</h3>
      <p>
        Instead of emailing PDFs, subcontractors click <strong>Create Bill</strong> next to an active contract:
      </p>
      <ul>
        <li>They see their contract schedule of values (SOV) lines.</li>
        <li>They input the percentage of work completed for this billing period (e.g., 80% complete on framing labor).</li>
        <li>Arc calculates the billing total, automatically applies the project&apos;s contract retainage withholding, and creates a draft vendor bill in your Cost Inbox for review.</li>
      </ul>

      <h3>2. Uploading insurance compliance</h3>
      <p>
        If a subcontractor&apos;s Certificate of Insurance (COI) is expired, the portal displays a compliance warning. 
        Subcontractors can upload new PDFs directly to the portal, entering the expiration dates and policy numbers. 
        This routes the document to your office team for approval and clears payment holds.
      </p>

      <h3>3. Responding to RFIs</h3>
      <p>
        When you assign an RFI to a subcontractor, they can view the RFI question and references in their portal. 
        They can write responses, upload site photos or files, and submit them directly back to the project team.
      </p>

      <h3>4. Resolving punch items</h3>
      <p>
        During project closeout, subcontractors use the portal to view their assigned punch list deficiencies. 
        They can inspect the issues on-site, upload a photo showing their completed repairs, and click 
        <strong>Resolve Punch Item</strong>, which alerts the builder to review and close out the item.
      </p>
    </>
  )
}
