you have a solid database foundation but the application-level enforcement is missing. Here's
   the picture:

  What You Have ✅

  Database Layer (well designed):

  | Table            | Purpose                                                   |
  |------------------|-----------------------------------------------------------|
  | roles            | Defines roles with scope (org vs project)                 |
  | permissions      | Individual permission keys like org.admin, project.manage |
  | role_permissions | Maps roles → permissions                                  |
  | memberships      | Assigns users to orgs with a role                         |
  | project_members  | Assigns users to projects with a project-specific role    |

  Seeded Roles:
  Org-level:    owner → admin → staff → readonly
  Project-level: pm, field, client

  Seeded Permissions (9):
  org.admin, org.member, org.read
  project.manage, project.read
  billing.manage, audit.read, features.manage, members.manage

  RLS Policies: All tables protected by is_org_member(org_id) check

  Auth Context: requireOrgMembership() loads membership with role_key

  ---
  What's Missing ❌

  1. No Permission Enforcement in Code

  Services don't check permissions:
  // Current - anyone can do anything
  export async function createProject({ input, orgId }) {
    const { supabase, orgId, userId } = await requireOrgContext(orgId)
    // Just checks membership, not permissions
    return supabase.from("projects").insert(...)
  }

  // Needed
  export async function createProject({ input, orgId }) {
    const ctx = await requireOrgContext(orgId)
    await requirePermission(ctx, "project.manage")  // ← Missing
    return ctx.supabase.from("projects").insert(...)
  }

  2. No Permission Utilities

  Need to create lib/services/permissions.ts:
  // Check if user has specific permission
  export async function hasPermission(userId: string, orgId: string, permission: string):
  Promise<boolean>

  // Throw if missing permission
  export async function requirePermission(ctx: OrgContext, permission: string): Promise<void>

  // Get all permissions for user in org
  export async function getUserPermissions(userId: string, orgId: string): Promise<string[]>

  // Project-level permission check
  export async function hasProjectPermission(userId: string, projectId: string, permission: string):
   Promise<boolean>

  3. No Route Guards

  Middleware only checks auth, not roles:
  // Current middleware
  if (!session) redirect('/auth/signin')

  // Needed for /settings, /team management
  if (!hasPermission(userId, orgId, 'members.manage')) {
    redirect('/unauthorized')
  }

  4. No UI Conditional Rendering

  Components don't hide/show based on permissions:
  // Needed pattern
  const { permissions } = useAuth()

  {permissions.includes('project.manage') && (
    <Button>Create Project</Button>
  )}

  5. Portal Access Table Missing

  The portal_access_tokens table referenced in code doesn't exist in the schema yet.

  ---
  Quick Implementation Path

  To get basic RBAC working, you need these files:

  lib/services/permissions.ts     # Core permission checking
  lib/hooks/use-permissions.ts    # Client-side permission hook
  lib/auth/guards.ts              # Route/action guards

  Core Permission Service (~50 lines):

  // lib/services/permissions.ts
  import { createClient } from "@/lib/supabase/server"

  export async function getUserPermissions(userId: string, orgId: string): Promise<string[]> {
    const supabase = await createClient()

    const { data } = await supabase
      .from("memberships")
      .select(`
        role:roles!inner(
          permissions:role_permissions(permission_key)
        )
      `)
      .eq("user_id", userId)
      .eq("org_id", orgId)
      .eq("status", "active")
      .single()

    return data?.role?.permissions?.map(p => p.permission_key) ?? []
  }

  export async function hasPermission(
    userId: string,
    orgId: string,
    permission: string
  ): Promise<boolean> {
    const permissions = await getUserPermissions(userId, orgId)
    return permissions.includes(permission)
  }

  export async function requirePermission(
    userId: string,
    orgId: string,
    permission: string
  ): Promise<void> {
    if (!(await hasPermission(userId, orgId, permission))) {
      throw new Error(`Missing permission: ${permission}`)
    }
  }

  ---
  Recommendation

  For your directory features (Team/Contacts/Companies), you'll want basic RBAC:

  | Action                    | Required Permission           |
  |---------------------------|-------------------------------|
  | View team members         | org.member                    |
  | Invite/remove members     | members.manage                |
  | Change member roles       | org.admin                     |
  | View contacts/companies   | org.member                    |
  | Create/edit contacts      | org.member                    |
  | Delete contacts/companies | org.admin (or members.manage) |

  My suggestion: Build the directory UI first with permission checks stubbed, then implement the
  permission service. This lets you move fast while having the hooks in place for enforcement.