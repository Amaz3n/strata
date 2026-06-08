import Link from "next/link"

export default function AdministrationOverviewArticle() {
  return (
    <>
      <p>
        Workspace Administration covers organization-wide settings, users, permissions,
        billing, notifications, appearance, and security.
      </p>
      <h2>Organization and profile settings</h2>
      <p>
        Open <Link href="/settings">Settings</Link> to manage your profile and the settings
        available to your role. Organization settings affect the shared workspace.
      </p>
      <h2>Roles and permissions</h2>
      <p>
        Roles define a user&apos;s general place in the organization. Permission presets
        control the records and actions they can access. Apply the least access needed for
        the person&apos;s responsibilities.
      </p>
      <h2>Billing and integrations</h2>
      <p>
        Authorized administrators can manage the Arc subscription, payment method, and
        connected services.
      </p>
      <h2>Notifications and appearance</h2>
      <p>
        Users can adjust notification preferences and visual settings where those options
        are available.
      </p>
      <h2>Account security</h2>
      <p>
        Protect accounts with unique credentials and multi-factor authentication when
        enabled. Remove or suspend access promptly when a teammate no longer needs Arc.
      </p>
    </>
  )
}
