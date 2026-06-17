import Link from "next/link"

export default function ComplianceInsuranceArticle() {
  return (
    <>
      <p>
        Compliance tools manage risk by tracking subcontractor insurance certificates (Certificates of Insurance - COI), 
        W-9 forms, and business licenses. Arc validates coverage requirements, alerts you before documents expire, 
        and can automatically hold vendor payments for non-compliant subcontractors.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Required Document Types:</strong> Track General Liability (GL), Workers&apos; Compensation, Auto Liability, Umbrella Liability, W-9, and Business Licenses.</li>
        <li><strong>Coverage Checks:</strong> Log policy numbers, carrier names, coverage amounts, and verify Additional Insured and Waiver of Subrogation endorsements.</li>
        <li><strong>Review Workflow:</strong> Route uploaded COIs through review states: Pending, Approved, Replaced, or Rejected.</li>
        <li><strong>Expiration Alerts:</strong> Set expiration dates. Arc flags documents nearing expiration or already expired.</li>
        <li><strong>Automatic Payment Blocks:</strong> Block payments on vendor bills automatically if required compliance documents are missing or expired.</li>
      </ul>

      <h2>Setting Up Compliance Requirements</h2>
      <p>
        Requirements define what a company must provide to be compliant. You can set workspace-wide defaults or 
        customize requirements for a specific subcontractor.
      </p>
      <ol>
        <li>Open the company record in the Directory and open the <strong>Compliance Requirements</strong> tab.</li>
        <li>Check the document types they are required to submit (e.g., General Liability and Workers&apos; Comp).</li>
        <li>Specify the <strong>Minimum Coverage Limit</strong> required (e.g., $1,000,000).</li>
        <li>Select endorsement requirements like <strong>Additional Insured</strong>, <strong>Primary &amp; Non-Contributory</strong>, or <strong>Waiver of Subrogation</strong>.</li>
      </ol>

      <h2>Uploading and Reviewing Documents</h2>
      <p>
        When a subcontractor provides a Certificate of Insurance (COI), upload the file under their company record:
      </p>
      <ul>
        <li>Input the insurance carrier, policy number, coverage amount, effective date, and expiration date.</li>
        <li>Check the boxes for any verified endorsements matching the COI printouts.</li>
        <li>Save the document. It enters a <strong>Pending Review</strong> status.</li>
      </ul>
      <p>
        An administrator reviews the uploaded file against the requirements. They can mark the document 
        <strong>Approved</strong> (which marks the company compliant) or <strong>Rejected</strong> (entering a 
        rejection reason that is shared with the subcontractor).
      </p>

      <h2>Payment Holds (Payment Blocking)</h2>
      <p>
        To protect your business, Arc supports automated financial holds:
      </p>
      <blockquote>
        <strong>Rule - Block Payment on Missing Docs:</strong> If this compliance rule is enabled in your workspace 
        settings, Arc automatically blocks payment execution on any vendor bills submitted by a subcontractor 
        who has expired or missing approved compliance documents. The bill is flagged with a compliance hold 
        until a new approved certificate is uploaded.
      </blockquote>
    </>
  )
}
