import Link from "next/link"

export default function PlanningOverviewArticle() {
  return (
    <>
      <p>
        Arc&apos;s planning and document tools organize all files, drawing sheets, bids, requests, and electronic 
        approvals required throughout the lifecycle of a construction project. By housing these workflows under 
        one system, your project management, design, and field teams stay fully coordinated.
      </p>

      <h2>Core Modules in Planning &amp; Documents</h2>
      <p>
        Planning &amp; Documents is comprised of six integrated modules. Review the detailed guides below to learn 
        how to use each tool:
      </p>

      <h3>1. Documents</h3>
      <p>
        Documents functions as your project&apos;s digital filing cabinet. Organize photos, PDFs, spreadsheets, 
        and subcontracts with customized folders, and safely share files with external clients or partners 
        using secure links.
        {" "}
        <Link href="/help/planning-and-documents/planning-workflows/documents">
          Read the Documents Guide
        </Link>
        .
      </p>

      <h3>2. Drawings</h3>
      <p>
        Drawings is a purpose-built viewer and manager for construction plans. Upload complete drawing sets, 
        rely on automatic sheet extraction, stack new revisions, and place markup links directly to RFIs or submittals.
        {" "}
        <Link href="/help/planning-and-documents/planning-workflows/drawings">
          Read the Drawings Guide
        </Link>
        .
      </p>

      <h3>3. Bids</h3>
      <p>
        Manage preconstruction procurement by setting up bid packages, inviting trade partners from your directory, 
        releasing addenda, and comparing subcontractor proposals in a secure bid portal.
        {" "}
        <Link href="/help/planning-and-documents/planning-workflows/bids">
          Read the Bidding Guide
        </Link>
        .
      </p>

      <h3>4. RFIs</h3>
      <p>
        Resolve ambiguities by creating formal Requests for Information. Assign them to architects or engineers, 
        track schedule and budget impacts, and record decision notes to ensure a reliable project history.
        {" "}
        <Link href="/help/planning-and-documents/planning-workflows/rfis">
          Read the RFIs Guide
        </Link>
        .
      </p>

      <h3>5. Submittals</h3>
      <p>
        Ensure quality control by managing submittals for shop drawings, product data, and material samples. 
        Track reviews, log formal approvals, and verify compliance before ordering project materials.
        {" "}
        <Link href="/help/planning-and-documents/planning-workflows/submittals">
          Read the Submittals Guide
        </Link>
        .
      </p>

      <h3>6. Signatures</h3>
      <p>
        Use the built-in electronic signature workflow to execute contracts, agreements, and change orders. 
        Set sequential signer routing, track envelope progress, and automatically store executed files.
        {" "}
        <Link href="/help/planning-and-documents/planning-workflows/signatures">
          Read the Signatures Guide
        </Link>
        .
      </p>
    </>
  )
}
