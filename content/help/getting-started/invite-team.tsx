import Link from "next/link"

export default function InviteTeamArticle() {
  return (
    <>
      <p>
        Invite internal teammates so they can sign in to your Arc organization and work
        with the projects and tools allowed by their role.
      </p>

      <h2>Invite a teammate</h2>
      <ol>
        <li>
          Open <Link href="/settings?tab=team">Settings → Team</Link>.
        </li>
        <li>Select <strong>Invite member</strong>.</li>
        <li>Enter the teammate&apos;s work email address.</li>
        <li>Choose their organization role and permission preset.</li>
        <li>Send the invite.</li>
      </ol>

      <h2>What happens next</h2>
      <p>
        Arc emails the teammate an invitation. They follow the secure link, create their
        account access, and enter your organization&apos;s workspace.
      </p>

      <h2>Organization access and project access</h2>
      <p>
        Inviting someone to the organization does not necessarily add them to every
        project. Open a project&apos;s team management tools when you need to assign that
        teammate to a specific job and project role.
      </p>

      <blockquote>
        Only users with permission to manage members can send invitations. Role changes
        may require organization administrator access.
      </blockquote>
    </>
  )
}
