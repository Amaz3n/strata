import { z } from "zod"

import { isProjectModuleKey } from "@/lib/project-modules"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"

const projectModuleOverrideSchema = z.object({
  projectId: z.string().uuid(),
  moduleKey: z.string().refine(isProjectModuleKey, "Unknown project module"),
  enabled: z.boolean(),
})

export async function setProjectModuleOverride(
  input: z.infer<typeof projectModuleOverrideSchema>,
  orgId?: string,
) {
  const parsed = projectModuleOverrideSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.projectId)
    .maybeSingle()

  if (projectError || !project) throw new Error("Project not found")

  const { data: before } = await supabase
    .from("project_module_overrides")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", parsed.projectId)
    .eq("module_key", parsed.moduleKey)
    .maybeSingle()

  const { data, error } = await supabase
    .from("project_module_overrides")
    .upsert(
      {
        org_id: resolvedOrgId,
        project_id: parsed.projectId,
        module_key: parsed.moduleKey,
        enabled: parsed.enabled,
      },
      { onConflict: "project_id,module_key" },
    )
    .select("*")
    .single()

  if (error) throw new Error(`Failed to update project module: ${error.message}`)

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: before ? "update" : "insert",
    entityType: "project_module_override",
    entityId: data.id,
    before,
    after: data,
  })

  return data
}
