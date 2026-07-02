import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import { requireAuth } from "@/lib/auth/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getCurrentPlatformAccess } from "@/lib/services/platform-access"
import type {
  PlatformBugAiReview,
  PlatformBug,
  PlatformBugEvent,
  PlatformBugInput,
  PlatformBugPerson,
  PlatformBugUpdate,
} from "@/lib/platform-bugs/types"

const BUG_SELECT = `
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
  expected_behavior,
  actual_behavior,
  assignee_user_id,
  created_by,
  updated_by,
  due_at,
  started_at,
  resolved_at,
  archived_at,
  attachment_names,
  created_at,
  updated_at,
  assignee:app_users!platform_bugs_assignee_user_id_fkey(id, full_name, email, avatar_url),
  creator:app_users!platform_bugs_created_by_fkey(id, full_name, email, avatar_url),
  org:orgs!platform_bugs_org_id_fkey(id, name),
  project:projects!platform_bugs_project_id_fkey(id, name)
`

const EVENT_SELECT = `
  id,
  bug_id,
  actor_user_id,
  event_type,
  body,
  from_value,
  to_value,
  created_at,
  actor:app_users!platform_bug_events_actor_user_id_fkey(id, full_name, email, avatar_url)
`

const BUG_ATTACHMENT_BUCKET = "platform-bug-attachments"
const CODEX_REVIEW_WORKFLOW = "codex-bug-review.yml"

const AI_REVIEW_SELECT = `
  id,
  bug_id,
  status,
  provider,
  requested_by,
  github_owner,
  github_repo,
  github_workflow,
  github_ref,
  github_run_id,
  github_run_url,
  summary,
  proposal,
  raw_output,
  error,
  completed_at,
  created_at,
  updated_at
`

function normalizePerson(row: any): PlatformBugPerson | null {
  const person = Array.isArray(row) ? row[0] : row
  if (!person?.id) return null
  return {
    id: person.id,
    full_name: person.full_name ?? null,
    email: person.email ?? null,
    avatar_url: person.avatar_url ?? null,
  }
}

function normalizeRef(row: any): { id: string; name: string } | null {
  const ref = Array.isArray(row) ? row[0] : row
  if (!ref?.id) return null
  return { id: ref.id, name: ref.name ?? "" }
}

function normalizeBug(row: any): PlatformBug {
  return {
    ...row,
    attachment_names: Array.isArray(row.attachment_names) ? row.attachment_names : [],
    assignee: normalizePerson(row.assignee),
    creator: normalizePerson(row.creator),
    org: normalizeRef(row.org),
    project: normalizeRef(row.project),
  } as PlatformBug
}

function normalizeEvent(row: any): PlatformBugEvent {
  return {
    ...row,
    actor: normalizePerson(row.actor),
  } as PlatformBugEvent
}

function normalizeAiReview(row: any): PlatformBugAiReview {
  return {
    ...row,
    proposal: row?.proposal && typeof row.proposal === "object" && !Array.isArray(row.proposal) ? row.proposal : {},
  } as PlatformBugAiReview
}

function cleanText(value?: string | null) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function cleanAttachmentNames(names?: string[]) {
  return Array.from(new Set((names ?? []).map((name) => name.trim()).filter(Boolean))).slice(0, 8)
}

function getCodexReviewRepo() {
  const configured = process.env.CODEX_REVIEW_GITHUB_REPOSITORY?.trim() || process.env.GITHUB_REPOSITORY?.trim()
  if (!configured || !configured.includes("/")) return null
  const [owner, repo] = configured.split("/", 2)
  if (!owner || !repo) return null
  return { owner, repo }
}

function getAppBaseUrl() {
  const explicit = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL
  if (explicit?.trim()) return explicit.trim().replace(/\/$/, "")
  if (process.env.VERCEL_URL?.trim()) return `https://${process.env.VERCEL_URL.trim()}`.replace(/\/$/, "")
  return null
}

function parseJsonObject(raw: string | null | undefined) {
  if (!raw?.trim()) return {}
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]
  if (fenced) candidates.push(fenced.trim())
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      continue
    }
  }
  return {}
}

function summarizeReviewOutput(output: string | null | undefined, proposal: Record<string, unknown>) {
  const summary = proposal.summary
  if (typeof summary === "string" && summary.trim()) return summary.trim().slice(0, 1000)

  const text = output?.trim()
  if (!text) return null
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join("\n")
    .slice(0, 1000)
}

export async function requirePlatformBugOwner() {
  const { user } = await requireAuth()
  const access = await getCurrentPlatformAccess()
  const allowed = access.isEnvSuperadmin || access.roles.includes("platform_super_admin")
  if (!allowed) {
    throw new Error("Only Arc platform owners can access bug tracking.")
  }
  return { user, access }
}

export async function listPlatformBugOwners() {
  const { user } = await requirePlatformBugOwner()
  const supabase = createServiceSupabaseClient()

  const { data, error } = await supabase
    .from("platform_memberships")
    .select("user:app_users!platform_memberships_user_id_fkey(id, full_name, email, avatar_url), role:roles!inner(key)")
    .eq("status", "active")
    .eq("role.key", "platform_super_admin")

  if (error) {
    throw new Error(`Failed to load platform owners: ${error.message}`)
  }

  const owners = (data ?? [])
    .map((row: any) => normalizePerson(row.user))
    .filter((person): person is PlatformBugPerson => Boolean(person?.id))

  if (!owners.some((owner) => owner.id === user.id)) {
    const { data: currentUser } = await supabase
      .from("app_users")
      .select("id, full_name, email, avatar_url")
      .eq("id", user.id)
      .maybeSingle()

    owners.unshift(
      normalizePerson(currentUser) ?? {
        id: user.id,
        full_name: user.user_metadata?.full_name ?? user.email ?? null,
        email: user.email ?? null,
        avatar_url: user.user_metadata?.avatar_url ?? null,
      },
    )
  }

  return Array.from(new Map(owners.map((owner) => [owner.id, owner])).values())
}

export async function listPlatformBugContextOptions() {
  await requirePlatformBugOwner()
  const supabase = createServiceSupabaseClient()

  const { data, error } = await supabase
    .from("orgs")
    .select("id, name")
    .order("name", { ascending: true })

  if (error) {
    throw new Error(`Failed to load organizations: ${error.message}`)
  }

  return {
    orgs: (data ?? []).map((org: any) => ({ id: org.id as string, name: org.name as string })),
  }
}

export async function listPlatformBugProjectsForOrg(orgId: string) {
  await requirePlatformBugOwner()
  const supabase = createServiceSupabaseClient()

  const { data, error } = await supabase
    .from("projects")
    .select("id, name")
    .eq("org_id", orgId)
    .order("name", { ascending: true })
    .limit(500)

  if (error) {
    throw new Error(`Failed to load projects: ${error.message}`)
  }

  return (data ?? []).map((project: any) => ({ id: project.id as string, name: project.name as string }))
}

export async function listPlatformBugs() {
  await requirePlatformBugOwner()
  const supabase = createServiceSupabaseClient()

  const { data, error } = await supabase
    .from("platform_bugs")
    .select(BUG_SELECT)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to load platform bugs: ${error.message}`)
  }

  return (data ?? []).map(normalizeBug)
}

export async function listPlatformBugEvents(bugIds: string[]) {
  await requirePlatformBugOwner()
  if (bugIds.length === 0) return [] as PlatformBugEvent[]

  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("platform_bug_events")
    .select(EVENT_SELECT)
    .in("bug_id", bugIds)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to load platform bug activity: ${error.message}`)
  }

  return (data ?? []).map(normalizeEvent)
}

export async function listPlatformBugAiReviews(bugIds: string[]) {
  await requirePlatformBugOwner()
  if (bugIds.length === 0) return [] as PlatformBugAiReview[]

  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("platform_bug_ai_reviews")
    .select(AI_REVIEW_SELECT)
    .in("bug_id", bugIds)
    .order("updated_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to load AI reviews: ${error.message}`)
  }

  const latestByBug = new Map<string, PlatformBugAiReview>()
  for (const row of data ?? []) {
    const review = normalizeAiReview(row)
    if (!latestByBug.has(review.bug_id)) latestByBug.set(review.bug_id, review)
  }
  return Array.from(latestByBug.values())
}

async function recordEvent(
  supabase: SupabaseClient,
  input: {
    bugId: string
    actorUserId: string | null
    eventType: PlatformBugEvent["event_type"]
    body?: string | null
    fromValue?: string | null
    toValue?: string | null
    metadata?: Record<string, unknown>
  },
) {
  const { error } = await supabase.from("platform_bug_events").insert({
    bug_id: input.bugId,
    actor_user_id: input.actorUserId,
    event_type: input.eventType,
    body: cleanText(input.body),
    from_value: input.fromValue ?? null,
    to_value: input.toValue ?? null,
    metadata: input.metadata ?? {},
  })

  if (error) {
    throw new Error(`Failed to record bug activity: ${error.message}`)
  }
}

export async function createPlatformBug(input: PlatformBugInput) {
  const { user } = await requirePlatformBugOwner()
  const supabase = createServiceSupabaseClient()
  const title = cleanText(input.title)
  if (!title) throw new Error("Bug title is required.")

  const now = new Date().toISOString()
  const status = input.status ?? "triage"

  const { data, error } = await supabase
    .from("platform_bugs")
    .insert({
      title,
      description: cleanText(input.description),
      status,
      priority: input.priority ?? "medium",
      source: cleanText(input.source) ?? "manual",
      environment: cleanText(input.environment),
      org_id: input.orgId || null,
      project_id: input.projectId || null,
      expected_behavior: cleanText(input.expectedBehavior),
      actual_behavior: cleanText(input.actualBehavior),
      assignee_user_id: input.assigneeUserId || null,
      due_at: input.dueAt || null,
      started_at: status === "in_progress" ? now : null,
      resolved_at: status === "done" || status === "wont_fix" ? now : null,
      attachment_names: cleanAttachmentNames(input.attachmentNames),
      created_by: user.id,
      updated_by: user.id,
    })
    .select(BUG_SELECT)
    .single()

  if (error) {
    throw new Error(`Failed to create platform bug: ${error.message}`)
  }

  await recordEvent(supabase, {
    bugId: data.id,
    actorUserId: user.id,
    eventType: "created",
    body: title,
    toValue: status,
  })

  return normalizeBug(data)
}

export async function createPlatformSupportIssue(input: {
  userId: string
  orgId: string
  orgName?: string | null
  requesterName?: string | null
  requesterEmail?: string | null
  topicLabel: string
  topicKey: string
  message: string
  pageUrl?: string | null
}) {
  const supabase = createServiceSupabaseClient()
  const titlePrefix = input.topicKey === "feedback" ? "Feature request" : "Support request"
  const firstLine = input.message.split("\n").find((line) => line.trim().length > 0)?.trim() ?? input.topicLabel
  const title = `${titlePrefix}: ${firstLine.slice(0, 120)}`
  const description = [
    input.message.trim(),
    "",
    "Context",
    `Topic: ${input.topicLabel}`,
    `Requester: ${input.requesterName ?? "Unknown"}${input.requesterEmail ? ` <${input.requesterEmail}>` : ""}`,
    `Organization: ${input.orgName ?? "Unknown organization"} (${input.orgId})`,
    `Page: ${input.pageUrl || "Not provided"}`,
  ].join("\n")

  const { data, error } = await supabase
    .from("platform_bugs")
    .insert({
      title,
      description,
      status: "triage",
      priority: input.topicKey === "technical" || input.topicKey === "account" ? "high" : "medium",
      source: `support:${input.topicKey}`,
      environment: input.pageUrl || null,
      org_id: input.orgId,
      created_by: input.userId,
      updated_by: input.userId,
    })
    .select("id, issue_key")
    .single()

  if (error) {
    throw new Error(`Failed to create support issue: ${error.message}`)
  }

  await recordEvent(supabase, {
    bugId: data.id,
    actorUserId: input.userId,
    eventType: "created",
    body: title,
    toValue: "triage",
    metadata: {
      source: "support_request",
      topic: input.topicKey,
      page_url: input.pageUrl ?? null,
    },
  })

  dispatchPlatformBugAiReview(data.id, input.userId).catch((error) => {
    console.error("Failed to start Codex review for support issue", error)
  })

  return { id: data.id as string, issueKey: data.issue_key as string }
}

async function dispatchPlatformBugAiReview(bugId: string, requestedBy: string | null) {
  const supabase = createServiceSupabaseClient()

  const { data: bug, error: bugError } = await supabase
    .from("platform_bugs")
    .select(BUG_SELECT)
    .eq("id", bugId)
    .single()

  if (bugError) {
    throw new Error(`Failed to load platform bug: ${bugError.message}`)
  }

  const repo = getCodexReviewRepo()
  const token = process.env.CODEX_REVIEW_GITHUB_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim()
  const ref = process.env.CODEX_REVIEW_GITHUB_REF?.trim() || "main"
  const appBaseUrl = getAppBaseUrl()
  const callbackSecret = process.env.CODEX_REVIEW_CALLBACK_SECRET?.trim()

  if (!repo || !token || !appBaseUrl || !callbackSecret) {
    throw new Error("Codex review is not configured. Set CODEX_REVIEW_GITHUB_REPOSITORY, CODEX_REVIEW_GITHUB_TOKEN, NEXT_PUBLIC_APP_URL or APP_URL, and CODEX_REVIEW_CALLBACK_SECRET.")
  }

  const normalizedBug = normalizeBug(bug)
  const { data: review, error: reviewError } = await supabase
    .from("platform_bug_ai_reviews")
    .insert({
      bug_id: bugId,
      status: "queued",
      provider: "codex",
      requested_by: requestedBy,
      github_owner: repo.owner,
      github_repo: repo.repo,
      github_workflow: CODEX_REVIEW_WORKFLOW,
      github_ref: ref,
    })
    .select(AI_REVIEW_SELECT)
    .single()

  if (reviewError) {
    throw new Error(`Failed to create AI review: ${reviewError.message}`)
  }

  const callbackUrl = `${appBaseUrl}/api/platform/bugs/ai-review-callback`
  const bugPayload = {
    id: normalizedBug.id,
    issue_key: normalizedBug.issue_key,
    title: normalizedBug.title,
    description: normalizedBug.description,
    status: normalizedBug.status,
    priority: normalizedBug.priority,
    source: normalizedBug.source,
    environment: normalizedBug.environment,
    org: normalizedBug.org,
    project: normalizedBug.project,
    expected_behavior: normalizedBug.expected_behavior,
    actual_behavior: normalizedBug.actual_behavior,
    attachment_names: normalizedBug.attachment_names,
    created_at: normalizedBug.created_at,
    updated_at: normalizedBug.updated_at,
  }

  const response = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/actions/workflows/${CODEX_REVIEW_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        ref,
        inputs: {
          bug_id: bugId,
          review_id: review.id,
          bug_payload: JSON.stringify(bugPayload, null, 2),
          callback_url: callbackUrl,
        },
      }),
    },
  )

  if (!response.ok) {
    const details = await response.text().catch(() => "")
    await supabase
      .from("platform_bug_ai_reviews")
      .update({
        status: "failed",
        error: `GitHub dispatch failed (${response.status}): ${details.slice(0, 1000)}`,
        completed_at: new Date().toISOString(),
      })
      .eq("id", review.id)
    throw new Error(`GitHub dispatch failed (${response.status}).`)
  }

  const { data: dispatchedReview, error: updateError } = await supabase
    .from("platform_bug_ai_reviews")
    .update({ status: "dispatched" })
    .eq("id", review.id)
    .select(AI_REVIEW_SELECT)
    .single()

  if (updateError) {
    throw new Error(`Failed to mark AI review dispatched: ${updateError.message}`)
  }

  await recordEvent(supabase, {
    bugId,
    actorUserId: requestedBy,
    eventType: "commented",
    body: "Codex AI review started.",
    metadata: { ai_review_id: review.id, provider: "codex" },
  })

  return normalizeAiReview(dispatchedReview)
}

export async function startPlatformBugAiReview(bugId: string) {
  const { user } = await requirePlatformBugOwner()
  return dispatchPlatformBugAiReview(bugId, user.id)
}

export async function completePlatformBugAiReview(input: {
  reviewId: string
  bugId: string
  status: "proposal_ready" | "failed"
  output?: string | null
  error?: string | null
  githubRunId?: string | null
  githubRunUrl?: string | null
}) {
  const supabase = createServiceSupabaseClient()
  const proposal = parseJsonObject(input.output)
  const summary = input.status === "proposal_ready" ? summarizeReviewOutput(input.output, proposal) : null

  const { data, error } = await supabase
    .from("platform_bug_ai_reviews")
    .update({
      status: input.status,
      github_run_id: cleanText(input.githubRunId),
      github_run_url: cleanText(input.githubRunUrl),
      summary,
      proposal,
      raw_output: cleanText(input.output),
      error: cleanText(input.error),
      completed_at: new Date().toISOString(),
    })
    .eq("id", input.reviewId)
    .eq("bug_id", input.bugId)
    .select(AI_REVIEW_SELECT)
    .single()

  if (error) {
    throw new Error(`Failed to complete AI review: ${error.message}`)
  }

  await recordEvent(supabase, {
    bugId: input.bugId,
    actorUserId: null,
    eventType: "commented",
    body: input.status === "proposal_ready"
      ? `Codex AI review is ready.${summary ? `\n\n${summary}` : ""}`
      : `Codex AI review failed.${input.error ? `\n\n${input.error}` : ""}`,
    metadata: {
      ai_review_id: input.reviewId,
      provider: "codex",
      github_run_id: input.githubRunId ?? null,
      github_run_url: input.githubRunUrl ?? null,
    },
  })

  return normalizeAiReview(data)
}

export async function uploadPlatformBugAttachments(input: {
  bugId: string
  files: File[]
  attachmentNames: string[]
}) {
  const { user } = await requirePlatformBugOwner()
  const supabase = createServiceSupabaseClient()
  const uploadedNames: string[] = []

  for (const file of input.files) {
    if (!file || file.size === 0) continue
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "attachment"
    const storagePath = `${input.bugId}/${crypto.randomUUID()}-${safeName}`
    const contentType = file.type || (safeName.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream")

    const { error: uploadError } = await supabase.storage
      .from(BUG_ATTACHMENT_BUCKET)
      .upload(storagePath, file, {
        contentType,
        upsert: false,
      })

    if (uploadError) {
      throw new Error(`Failed to upload ${file.name}: ${uploadError.message}`)
    }

    const { error: insertError } = await supabase.from("platform_bug_attachments").insert({
      bug_id: input.bugId,
      uploaded_by: user.id,
      bucket_id: BUG_ATTACHMENT_BUCKET,
      storage_path: storagePath,
      file_name: file.name,
      content_type: contentType,
      size_bytes: file.size,
    })

    if (insertError) {
      throw new Error(`Failed to save attachment record: ${insertError.message}`)
    }

    uploadedNames.push(file.name)
  }

  const allNames = cleanAttachmentNames([...input.attachmentNames, ...uploadedNames])
  if (allNames.length > 0) {
    const { error } = await supabase
      .from("platform_bugs")
      .update({ attachment_names: allNames, updated_by: user.id })
      .eq("id", input.bugId)

    if (error) {
      throw new Error(`Failed to update attachment summary: ${error.message}`)
    }
  }

  return allNames
}

export async function updatePlatformBug(id: string, input: PlatformBugUpdate) {
  const { user } = await requirePlatformBugOwner()
  const supabase = createServiceSupabaseClient()

  const { data: existing, error: existingError } = await supabase
    .from("platform_bugs")
    .select("id, status, priority, assignee_user_id")
    .eq("id", id)
    .single()

  if (existingError) {
    throw new Error(`Failed to load platform bug: ${existingError.message}`)
  }

  const updates: Record<string, unknown> = {
    updated_by: user.id,
  }

  if (input.title !== undefined) {
    const title = cleanText(input.title)
    if (!title) throw new Error("Bug title is required.")
    updates.title = title
  }
  if (input.description !== undefined) updates.description = cleanText(input.description)
  if (input.status !== undefined) {
    updates.status = input.status
    if (input.status === "in_progress" && existing.status !== "in_progress") updates.started_at = new Date().toISOString()
    if ((input.status === "done" || input.status === "wont_fix") && existing.status !== input.status) updates.resolved_at = new Date().toISOString()
    if (input.status !== "done" && input.status !== "wont_fix") updates.resolved_at = null
  }
  if (input.priority !== undefined) updates.priority = input.priority
  if (input.source !== undefined) updates.source = cleanText(input.source) ?? "manual"
  if (input.environment !== undefined) updates.environment = cleanText(input.environment)
  if (input.orgId !== undefined) updates.org_id = input.orgId || null
  if (input.projectId !== undefined) updates.project_id = input.projectId || null
  if (input.expectedBehavior !== undefined) updates.expected_behavior = cleanText(input.expectedBehavior)
  if (input.actualBehavior !== undefined) updates.actual_behavior = cleanText(input.actualBehavior)
  if (input.assigneeUserId !== undefined) updates.assignee_user_id = input.assigneeUserId || null
  if (input.dueAt !== undefined) updates.due_at = input.dueAt || null
  if (input.attachmentNames !== undefined) updates.attachment_names = cleanAttachmentNames(input.attachmentNames)

  const { data, error } = await supabase
    .from("platform_bugs")
    .update(updates)
    .eq("id", id)
    .select(BUG_SELECT)
    .single()

  if (error) {
    throw new Error(`Failed to update platform bug: ${error.message}`)
  }

  const events: Array<Parameters<typeof recordEvent>[1]> = []
  if (input.status !== undefined && input.status !== existing.status) {
    events.push({ bugId: id, actorUserId: user.id, eventType: "status_changed", fromValue: existing.status, toValue: input.status })
  }
  if (input.priority !== undefined && input.priority !== existing.priority) {
    events.push({ bugId: id, actorUserId: user.id, eventType: "priority_changed", fromValue: existing.priority, toValue: input.priority })
  }
  if (input.assigneeUserId !== undefined && (input.assigneeUserId || null) !== existing.assignee_user_id) {
    events.push({ bugId: id, actorUserId: user.id, eventType: "assignee_changed", fromValue: existing.assignee_user_id, toValue: input.assigneeUserId || null })
  }
  if (events.length === 0) {
    events.push({ bugId: id, actorUserId: user.id, eventType: "edited" })
  }

  for (const event of events) {
    await recordEvent(supabase, event)
  }

  return normalizeBug(data)
}

export async function addPlatformBugComment(id: string, body: string) {
  const { user } = await requirePlatformBugOwner()
  const supabase = createServiceSupabaseClient()
  const comment = cleanText(body)
  if (!comment) throw new Error("Comment cannot be empty.")

  await recordEvent(supabase, {
    bugId: id,
    actorUserId: user.id,
    eventType: "commented",
    body: comment,
  })
}

export async function deletePlatformBug(id: string) {
  await requirePlatformBugOwner()
  const supabase = createServiceSupabaseClient()

  // Events and attachments cascade via their bug_id foreign keys.
  const { error } = await supabase.from("platform_bugs").delete().eq("id", id)

  if (error) {
    throw new Error(`Failed to delete platform bug: ${error.message}`)
  }
}

export async function archivePlatformBug(id: string) {
  const { user } = await requirePlatformBugOwner()
  const supabase = createServiceSupabaseClient()

  const { error } = await supabase
    .from("platform_bugs")
    .update({ archived_at: new Date().toISOString(), updated_by: user.id })
    .eq("id", id)

  if (error) {
    throw new Error(`Failed to archive platform bug: ${error.message}`)
  }

  await recordEvent(supabase, {
    bugId: id,
    actorUserId: user.id,
    eventType: "archived",
  })
}
