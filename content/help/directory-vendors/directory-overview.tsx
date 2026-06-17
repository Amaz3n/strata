import Link from "next/link"

export default function DirectoryOverviewArticle() {
  return (
    <>
      <p>
        The Directory stores the companies and contacts your organization works with across all projects. 
        Maintaining central records enables streamlined preconstruction bidding, project assignments, 
        and compliance auditing.
      </p>

      <h2>Core Modules in Directory &amp; Vendors</h2>
      <p>
        Directory &amp; Vendors is comprised of three key workflows. Click the detailed guides below to learn how 
        to manage each phase:
      </p>

      <h3>1. Companies &amp; Contacts</h3>
      <p>
        Add companies, specify types and trades, record prequalification credentials, link employee contacts, 
        and map companies to QuickBooks Online vendor records.
        {" "}
        <Link href="/help/directory-and-vendors/directory-basics/companies-contacts">
          Read the Companies &amp; Contacts Guide
        </Link>
        .
      </p>

      <h3>2. Project Assignments</h3>
      <p>
        Connect directory companies to specific projects, designate project roles and scopes of work, and track active 
        vendors working on each job site.
        {" "}
        <Link href="/help/directory-and-vendors/directory-basics/project-assignments">
          Read the Project Assignments Guide
        </Link>
        .
      </p>

      <h3>3. Compliance &amp; Insurance</h3>
      <p>
        Track Certificates of Insurance (COI) and W-9s, define minimum coverage limits, review compliance documents, 
        and manage automated compliance payment holds.
        {" "}
        <Link href="/help/directory-and-vendors/directory-basics/compliance-insurance">
          Read the Compliance &amp; Insurance Guide
        </Link>
        .
      </p>
    </>
  )
}
