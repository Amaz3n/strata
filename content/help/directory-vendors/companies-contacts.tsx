import Link from "next/link"

export default function CompaniesContactsArticle() {
  return (
    <>
      <p>
        The Directory is your company&apos;s master database of external partners. Rather than recreating contact 
        information for each project, you create a company or contact once in the workspace Directory and assign 
        them to specific projects as needed.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Company Profiling:</strong> Classify companies by type (Subcontractor, Vendor, Client, Architect, Engineer, Consultant) and primary trade (e.g., Concrete, Electrical, Framing).</li>
        <li><strong>Prequalification Status:</strong> Track subcontractor prequalifications, prequalified dates, and performance ratings.</li>
        <li><strong>Financial Terms:</strong> Save default payment terms (e.g., Net 30, Net 15) and internal notes on company records.</li>
        <li><strong>Contact Links:</strong> Associate multiple employee contacts under a single company record.</li>
        <li><strong>Accounting Linkage:</strong> Link directory companies directly to QuickBooks Online vendor records.</li>
      </ul>

      <h2>Adding Companies and Contacts</h2>
      <p>
        To add a record, navigate to the <strong>Directory</strong> tab from your main sidebar.
      </p>
      
      <h3>1. Creating a Company</h3>
      <p>
        Click <strong>Add Company</strong>. Enter the company name, select its type and primary trade, and enter 
        general office phone numbers, emails, website, and physical address.
      </p>

      <h3>2. Creating a Contact</h3>
      <p>
        Click <strong>Add Contact</strong>. Input their name, phone, email, and specific job role. 
        Select the company they work for in the <strong>Primary Company</strong> field to link them.
      </p>
      <blockquote>
        <strong>Note:</strong> Contacts can be invited to access subcontractor portals (for bidding or punch walks) 
        without needing to register a full Arc account.
      </blockquote>

      <h2>Prequalification and Ratings</h2>
      <p>
        Before awarding subcontracts, you can log vetting details on the company record:
      </p>
      <ul>
        <li><strong>Prequalified:</strong> Toggle the prequalification flag and record the prequalified date.</li>
        <li><strong>License Number:</strong> Save their professional contractor license number.</li>
        <li><strong>Rating:</strong> Assign a performance rating based on past project work to help estimators choose the right partners.</li>
      </ul>

      <h2>QuickBooks Online Vendor Mapping</h2>
      <p>
        If your workspace is integrated with QuickBooks Online:
      </p>
      <ol>
        <li>Open a company details card and click <strong>Link QuickBooks Vendor</strong>.</li>
        <li>Search for the corresponding QuickBooks vendor record.</li>
        <li>Click **Link**.</li>
      </ol>
      <p>
        Linking companies maps their financial profiles. When you sync subcontractor bills or credit card 
        expenses in Arc, they post to the correct vendor account in your QuickBooks ledger, eliminating double entry.
      </p>
    </>
  )
}
