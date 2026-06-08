import Link from "next/link"

export default function DirectoryOverviewArticle() {
  return (
    <>
      <p>
        The Directory stores the companies and people your organization works with across
        projects.
      </p>
      <h2>Companies and contacts</h2>
      <p>
        Open <Link href="/directory">Directory</Link> to find or add companies and
        contacts. Keep shared details on the directory record instead of recreating the
        same party separately for each project.
      </p>
      <h2>Project assignments</h2>
      <p>
        Directory records can be assigned to projects with a project-specific role, scope,
        and notes.
      </p>
      <h2>Vendor records</h2>
      <p>
        Vendor information supports commitments, bills, payments, bid invitations, and
        project participation. When QuickBooks is connected, an Arc company can be linked
        to its QuickBooks vendor.
      </p>
      <h2>Compliance</h2>
      <p>
        Compliance tools can track required vendor documents, expiration, review status,
        lien waiver requirements, and payment blocks configured by the organization.
      </p>
    </>
  )
}
