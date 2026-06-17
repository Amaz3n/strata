import Link from "next/link"

export default function ProjectConversionArticle() {
  return (
    <>
      <p>
        The Project Conversion workflow promotes a preconstruction prospect into an active project. 
        It automates contact promotions, migrates files, drawing sets, and bid packages, and initializes 
        your project budget and contract files.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Contact Promotion:</strong> Promotes all prospect contacts to active Directory contacts.</li>
        <li><strong>Project Record Creation:</strong> Automatically creates the project record, carrying over location, description, and project types.</li>
        <li><strong>Automatic File Migration:</strong> Migrates file storage paths from `/prospects/` to `/projects/` automatically.</li>
        <li><strong>Contract &amp; Budget Generation:</strong> Initializes the project contract and budget directly from the accepted proposal.</li>
        <li><strong>Allowance Item Setup:</strong> Populates the project allowance ledger from the proposal allowance lines.</li>
      </ul>

      <h2>The Conversion Trigger</h2>
      <p>
        A prospect is promoted to a project in one of two ways:
      </p>
      <ol>
        <li>
          <strong>Manual Promotion:</strong> Navigate to the prospect details, update the status to <strong>Executed</strong>, 
          and click <strong>Convert to Project</strong>.
        </li>
        <li>
          <strong>Proposal Acceptance:</strong> When a client signs and accepts a proposal in the Client Portal, 
          Arc automatically triggers the conversion.
        </li>
      </ol>

      <h2>What Happens During Conversion?</h2>
      <p>
        Behind the scenes, Arc coordinates a series of data migrations to ensure a seamless transition:
      </p>

      <h3>1. Contact promotion</h3>
      <p>
        All contacts associated with the prospect (such as the homeowners, client representatives, and designers) 
        are promoted to active contacts in your company&apos;s master <strong>Directory</strong>, preserving their 
        phone numbers, emails, and primary company mappings.
      </p>

      <h3>2. Project initialization</h3>
      <p>
        Arc creates the new project, carrying over:
      </p>
      <ul>
        <li>The prospect name as the project name.</li>
        <li>The jobsite location address.</li>
        <li>The project type (e.g., Remodel, New Construction) and property type (Residential, Commercial).</li>
        <li>Your notes as the project description.</li>
      </ul>

      <h3>3. File and drawing migration</h3>
      <p>
        All documents, preconstruction photos, and drawings are automatically transferred. 
        Arc updates the file storage directory paths from <code>/prospects/&#123;id&#125;</code> to 
        <code>/projects/&#123;id&#125;</code> behind the scenes. Subcontractor bid packages and bids are 
        also re-linked to the new project.
      </p>

      <h3>4. Contract, budget, and allowances</h3>
      <p>
        If the conversion is triggered by proposal acceptance, Arc automatically:
      </p>
      <ul>
        <li>Generates the project **Contract** detailing the agreed-upon contract sum, terms, and schedule of values.</li>
        <li>Initializes the project **Budget** baseline matching the cost code structure in the proposal.</li>
        <li>Creates corresponding **Allowance Items** from the proposal&apos;s allowance lines to track finish selections as they occur.</li>
      </ul>
    </>
  )
}
