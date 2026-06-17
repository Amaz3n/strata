import Link from "next/link"

export default function TeamPermissionsArticle() {
  return (
    <>
      <p>
        The Team &amp; Permissions configuration module allows Workspace Administrators to manage internal team access,
        assign organizational roles, customize fine-grained permission overrides, and audit user activity. Keeping permissions
        properly configured ensures data security while maintaining frictionless operational workflows for project teams.
      </p>

      <h2>Organizational Roles</h2>
      <p>
        Every user invited to your Arc organization is assigned a primary organizational role. This role acts as their baseline set of permissions:
      </p>
      <ul>
        <li>
          <strong>Workspace Administrator (<code>org_admin</code>):</strong> Grants complete, unrestricted access across all workspaces, 
          projects, and administrative settings. Only Workspace Administrators can modify billing plans, access Stripe payouts, 
          configure QuickBooks integrations, invite or deactivate users, and delete core database records.
        </li>
        <li>
          <strong>Workspace User (<code>org_user</code>):</strong> Standard role for project managers, estimators, superintendents, 
          and office coordinators. By default, Workspace Users can only view and interact with projects to which they are explicitly assigned. 
          Their access is restricted to basic operations unless they are granted specific permission overrides.
        </li>
      </ul>

      <h2>The User Invitation Lifecycle</h2>
      <p>
        To invite a new team member, navigate to <strong>Settings → Team</strong> and click <strong>Invite Member</strong>.
      </p>
      <ol>
        <li><strong>Form Entry:</strong> Provide the user&apos;s email address, first name, last name, and select their primary role (Administrator or User).</li>
        <li><strong>Initial Overrides:</strong> Configure any starting permission overrides (e.g., granting a project manager write access to budgets).</li>
        <li><strong>Invitation Statuses:</strong>
          <ul>
            <li><strong>Pending:</strong> An invitation has been sent via email. The link is secure and valid for exactly 7 days.</li>
            <li><strong>Expired:</strong> If the user does not accept the invite within 7 days, the token expires. Administrators can click <strong>Resend Invite</strong> next to the user&apos;s name to generate a new token and send a new email.</li>
            <li><strong>Active:</strong> The user has clicked the invitation link, completed their profile setup, and logged into the workspace.</li>
          </ul>
        </li>
      </ol>

      <h2>Fine-Grained Permission Overrides</h2>
      <p>
        For standard Workspace Users, administrators can define specific permissions across four primary categories. This allows you to restrict sensitive financial data while giving superintendents full access to field logs:
      </p>

      <h3>1. Project Access</h3>
      <p>
        Controls the user&apos;s ability to modify project configuration parameters:
      </p>
      <ul>
        <li><strong>Create Projects:</strong> Grants the ability to create new projects from scratch or promote won prospects.</li>
        <li><strong>Archive/Close Projects:</strong> Allows users to toggle project statuses between active, archived, and completed.</li>
        <li><strong>Edit Project Details:</strong> Grants access to modify project names, addresses, target dates, and billing modes.</li>
      </ul>

      <h3>2. Documents &amp; Sharing</h3>
      <p>
        Governs file storage, specifications, drawings, and portal access:
      </p>
      <ul>
        <li><strong>Manage Files &amp; Folders:</strong> Grants permissions to create folder structures, upload documents, and delete files.</li>
        <li><strong>Drawings Management:</strong> Allows users to upload drawing sets, trigger OCR sheet extraction, and edit sheet details.</li>
        <li><strong>Portal Token Creation:</strong> Enables generating secure subcontractor, client, and bid portal access links.</li>
      </ul>

      <h3>3. Field Operations</h3>
      <p>
        Controls day-to-day project execution tools:
      </p>
      <ul>
        <li><strong>Schedule Publication:</strong> Allows editing the project schedule Gantt chart and publishing updates to the field.</li>
        <li><strong>Daily Log Approval:</strong> Grants permission to officially sign off and lock daily superintendent logs.</li>
        <li><strong>Punch List Resolution:</strong> Enables assigning punch items, verifying subcontractor repairs, and closing tickets.</li>
      </ul>

      <h3>4. Financial Control</h3>
      <p>
        Protects sensitive budget, contract, billing, and integration data:
      </p>
      <ul>
        <li><strong>Budget Editing:</strong> Grants write access to modify cost code baselines, original budget lines, and cost forecasts.</li>
        <li><strong>Commitments Management:</strong> Allows drafting and approving subcontracts, purchase orders, and retainage terms.</li>
        <li><strong>Vendor Bill Processing:</strong> Enables coding, reviewing, and approving incoming invoices (payables) for payment.</li>
        <li><strong>Receivables &amp; Client Draws:</strong> Permits generating progress invoices (receivables) and submitting them to clients.</li>
      </ul>

      <h2>Deactivating Users</h2>
      <p>
        When a team member leaves your organization, navigate to <strong>Settings → Team</strong>, click the actions menu next to their name, and select <strong>Deactivate User</strong>.
      </p>
      <ul>
        <li><strong>Data Preservation:</strong> Deactivation does not delete the user&apos;s history. All daily logs approved, files uploaded, RFIs answered, and budget changes made by the user remain attributed to their profile for audit and compliance purposes.</li>
        <li><strong>Project Assignments:</strong> The deactivated user is automatically removed from all active project assignment lists.</li>
      </ul>
    </>
  )
}
