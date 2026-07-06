import "server-only"

import { z } from "zod"

import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileUserContext } from "@/lib/mobile/auth"
import type { MobilePlatformAuditEntryDTO, MobilePlatformIssueDTO } from "@/lib/mobile/contracts"
import type { PlatformRoleKey } from "@/lib/services/platform-access"
import { listPlatformRoleKeysForUser } from "@/lib/services/platform-access"

const PLATFORM_OWNER_ROLES: PlatformRoleKey[] = [
  "platform_super_admin",
  "platform_admin",
  "platform_support_readonly",
  "platform_security_auditor",
]

const createIssueSchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(4000).optional().nullable(),
  priority: z.enum(["urgent", "high", "medium", "low"]).optional(),
  environment: z.string().trim().max(120).optional().nullable(),
  org_id: z.string().uuid().optional().nullable(),
  project_id: z.string().uuid().optional().nullable(),
  expected_behavior: z.string().trim().max(2000).optional().nullable(),
  actual_behavior: z.string().trim().max(2000).optional().nullable(),
})

function cleanText(value?: string | null) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export async function requireMobilePlatformOwner(context: MobileUserContext) {
  if (context.isPlatformAdmin) return

  const roles = await listPlatformRoleKeysForUser(context.user.id)
  if (!roles.some((role) => PLATFORM_OWNER_ROLES.includes(role))) {
    throw new MobileAPIError(403, "platform_forbidden", "Platform access is required.")
  }
}

export async function listMobilePlatformAuditEntries(context: MobileUserContext, limit: number) {
  await requireMobilePlatformOwner(context)

  const { data, error } = await context.serviceSupabase
    .from("authorization_audit_log")
    .select(
      `
        id,
        occurred_at,
        actor_user_id,
        org_id,
        project_id,
        action_key,
        resource_type,
        resource_id,
        decision,
        reason_code,
        request_id,
        ip,
        user_agent,
        actor:app_users!authorization_audit_log_actor_user_id_fkey(id, full_name, email),
        org:orgs!authorization_audit_log_org_id_fkey(id, name),
        project:projects!authorization_audit_log_project_id_fkey(id, name)
      `,
    )
    .order("occurred_at", { ascending: false })
    .limit(limit)

  if (error) {
    throw new MobileAPIError(500, "audit_log_unavailable", "Audit log could not be loaded.")
  }

  return (data ?? []).map((row: any): MobilePlatformAuditEntryDTO => {
    const actor = Array.isArray(row.actor) ? row.actor[0] : row.actor
    const org = Array.isArray(row.org) ? row.org[0] : row.org
    const project = Array.isArray(row.project) ? row.project[0] : row.project
    return {
      id: row.id,
      occurred_at: row.occurred_at,
      actor_user_id: row.actor_user_id,
      actor_name: actor?.full_name ?? actor?.email ?? null,
      org_id: row.org_id,
      org_name: org?.name ?? null,
      project_id: row.project_id,
      project_name: project?.name ?? null,
      action_key: row.action_key,
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      decision: row.decision,
      reason_code: row.reason_code,
      request_id: row.request_id,
      ip: row.ip,
      user_agent: row.user_agent,
    }
  })
}

export async function listMobilePlatformIssues(context: MobileUserContext, limit: number) {
  await requireMobilePlatformOwner(context)

  const { data, error } = await context.serviceSupabase
    .from("platform_bugs")
    .select(
      `
        id,
        issue_key,
        title,
        description,
        status,
        priority,
        source,
        environment,
        org_id,
        project_id,
        assignee_user_id,
        created_by,
        due_at,
        started_at,
        resolved_at,
        archived_at,
        attachment_names,
        created_at,
        updated_at,
        assignee:app_users!platform_bugs_assignee_user_id_fkey(id, full_name, email),
        creator:app_users!platform_bugs_created_by_fkey(id, full_name, email),
        org:orgs!platform_bugs_org_id_fkey(id, name),
        project:projects!platform_bugs_project_id_fkey(id, name)
      `,
    )
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(limit)

  if (error) {
    throw new MobileAPIError(500, "platform_issues_unavailable", "Platform issues could not be loaded.")
  }

  return (data ?? []).map(mapPlatformIssue)
}

export async function createMobilePlatformIssue(context: MobileUserContext, body: unknown) {
  await requireMobilePlatformOwner(context)

  const parsed = createIssueSchema.safeParse(body)
  if (!parsed.success) {
    throw new MobileAPIError(422, "invalid_issue", "Please check the issue fields.")
  }

  const input = parsed.data
  const { data, error } = await context.serviceSupabase
    .from("platform_bugs")
    .insert({
      title: input.title,
      description: cleanText(input.description),
      status: "triage",
      priority: input.priority ?? "medium",
      source: "ios",
      environment: cleanText(input.environment),
      org_id: input.org_id ?? null,
      project_id: input.project_id ?? null,
      expected_behavior: cleanText(input.expected_behavior),
      actual_behavior: cleanText(input.actual_behavior),
      created_by: context.user.id,
      updated_by: context.user.id,
    })
    .select(
      `
        id,
        issue_key,
        title,
        description,
        status,
        priority,
        source,
        environment,
        org_id,
        project_id,
        assignee_user_id,
        created_by,
        due_at,
        started_at,
        resolved_at,
        archived_at,
        attachment_names,
        created_at,
        updated_at,
        assignee:app_users!platform_bugs_assignee_user_id_fkey(id, full_name, email),
        creator:app_users!platform_bugs_created_by_fkey(id, full_name, email),
        org:orgs!platform_bugs_org_id_fkey(id, name),
        project:projects!platform_bugs_project_id_fkey(id, name)
      `,
    )
    .single()

  if (error) {
    throw new MobileAPIError(500, "platform_issue_create_failed", "Issue could not be created.")
  }

  await context.serviceSupabase.from("platform_bug_events").insert({
    bug_id: data.id,
    actor_user_id: context.user.id,
    event_type: "created",
    body: input.title,
    to_value: "triage",
    metadata: { source: "ios" },
  })

  return mapPlatformIssue(data)
}

function mapPlatformIssue(row: any): MobilePlatformIssueDTO {
  const assignee = Array.isArray(row.assignee) ? row.assignee[0] : row.assignee
  const creator = Array.isArray(row.creator) ? row.creator[0] : row.creator
  const org = Array.isArray(row.org) ? row.org[0] : row.org
  const project = Array.isArray(row.project) ? row.project[0] : row.project
  return {
    id: row.id,
    issue_key: row.issue_key,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    source: row.source,
    environment: row.environment,
    org_id: row.org_id,
    org_name: org?.name ?? null,
    project_id: row.project_id,
    project_name: project?.name ?? null,
    assignee_user_id: row.assignee_user_id,
    assignee_name: assignee?.full_name ?? assignee?.email ?? null,
    created_by: row.created_by,
    creator_name: creator?.full_name ?? creator?.email ?? null,
    due_at: row.due_at,
    started_at: row.started_at,
    resolved_at: row.resolved_at,
    attachment_names: Array.isArray(row.attachment_names) ? row.attachment_names : [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}
