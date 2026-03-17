import type { OrgServiceContext } from "@/lib/services/context"
import { postConversationMessageWithClient } from "@/lib/services/conversations"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const SUPPORTED_ACTION_TOOL_KEYS = new Set(["tasks.create", "messages.send"])
const MAX_ACTION_TEXT_LENGTH = 2_000
const ACTION_STALE_WINDOW_MS = 1000 * 60 * 30

export type AiSearchActionStatus = "proposed" | "running" | "executed" | "rejected" | "failed"

export interface AiSearchAction {
  id: string
  toolKey: string
  title: string
  summary: string
  status: AiSearchActionStatus
  requiresApproval: boolean
  args: Record<string, unknown>
  result: Record<string, unknown>
  error?: string
  createdAt: string
  updatedAt: string
  executedAt?: string
}

export interface CreateAiSearchActionRequestInput {
  sessionId?: string
  toolKey: string
  title: string
  summary: string
  args: Record<string, unknown>
  requiresApproval?: boolean
}

export interface ExecuteAiSearchActionRequestOptions {
  dryRun?: boolean
  idempotencyKey?: string
}

type ActionExecutionOutput = {
  summary: string
  href?: string
  result?: Record<string, unknown>
}

type ConversationLookupRow = {
  id: string
  subject?: string | null
  project_id?: string | null
  channel?: string | null
  projects?: { name?: string | null } | null
  companies?: { name?: string | null } | null
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  const output: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue
    if (typeof raw === "string" && raw.trim().length === 0) continue
    output[key] = raw
  }
  return output as T
}

function toOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeActionText(value: string, maxLength = MAX_ACTION_TEXT_LENGTH) {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) return normalized
  return normalized.slice(0, maxLength).trim()
}

function toOptionalDate(value: unknown): string | undefined {
  const text = toOptionalText(value)
  if (!text) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined
  const date = new Date(`${text}T00:00:00Z`)
  if (!Number.isFinite(date.getTime())) return undefined
  return text
}

function isUuid(value: string) {
  return UUID_PATTERN.test(value)
}

function parseActionArgs(raw: unknown) {
  const record = compactObject(toRecord(raw))
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      normalized[key] = normalizeActionText(value)
      continue
    }
    normalized[key] = value
  }
  return normalized
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`
}

function normalizeIdempotencyKey(value: unknown): string | undefined {
  const text = toOptionalText(value)
  if (!text) return undefined
  if (!/^[a-zA-Z0-9._:-]{6,120}$/.test(text)) {
    return undefined
  }
  return text
}

function normalizeActionStatus(value: unknown): AiSearchActionStatus {
  if (value === "proposed" || value === "running" || value === "executed" || value === "rejected" || value === "failed") {
    return value
  }
  return "proposed"
}

function extractActionIdempotencyKey(action: AiSearchAction): string | undefined {
  const value = action.result.idempotencyKey
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function toTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

function resolveRunningStartedAtMs(action: AiSearchAction): number | null {
  const fromResult = toTimestampMs(action.result.runningStartedAt)
  if (fromResult !== null) return fromResult
  return toTimestampMs(action.updatedAt)
}

function mapActionRow(row: any): AiSearchAction {
  return {
    id: row.id,
    toolKey: row.tool_key,
    title: row.title,
    summary: row.summary,
    status: normalizeActionStatus(row.status),
    requiresApproval: Boolean(row.requires_approval),
    args: toRecord(row.args),
    result: toRecord(row.result),
    error: toOptionalText(row.error),
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    executedAt: toOptionalText(row.executed_at),
  }
}

function mapTaskActionSummary(args: Record<string, unknown>) {
  const title = toOptionalText(args.title) ?? "Follow up"
  const dueDate = toOptionalDate(args.dueDate)
  const projectName = toOptionalText(args.projectName)
  const assigneeHint = toOptionalText(args.assigneeHint)
  const pieces = [`Create task "${title}"`]
  if (projectName) pieces.push(`for project ${projectName}`)
  if (dueDate) pieces.push(`due ${dueDate}`)
  if (assigneeHint) pieces.push(`assign to ${assigneeHint}`)
  return {
    title: `Create task: ${title}`,
    summary: `${pieces.join(" • ")}.`,
  }
}

function mapMessageActionSummary(args: Record<string, unknown>) {
  const body = toOptionalText(args.body) ?? "Quick follow-up from your assistant."
  const recipientHint = toOptionalText(args.recipientHint)
  const projectName = toOptionalText(args.projectName)
  const pieces = ["Send a message"]
  if (recipientHint) pieces.push(`to ${recipientHint}`)
  if (projectName) pieces.push(`for project ${projectName}`)
  return {
    title: recipientHint ? `Send message to ${recipientHint}` : "Send follow-up message",
    summary: `${pieces.join(" ")}. Draft: "${body.slice(0, 140)}"`,
  }
}

export function isAiActionToolKey(toolKey: string) {
  return SUPPORTED_ACTION_TOOL_KEYS.has(toolKey)
}

export function buildAiActionDraft(toolKey: string, rawArgs: Record<string, unknown>) {
  const args = parseActionArgs(rawArgs)
  if (toolKey === "tasks.create") {
    const summary = mapTaskActionSummary(args)
    return {
      title: summary.title,
      summary: summary.summary,
      args,
      requiresApproval: true,
    }
  }

  if (toolKey === "messages.send") {
    const summary = mapMessageActionSummary(args)
    return {
      title: summary.title,
      summary: summary.summary,
      args,
      requiresApproval: true,
    }
  }

  return null
}

async function resolveProjectId(context: OrgServiceContext, args: Record<string, unknown>): Promise<string | null> {
  const projectId = toOptionalText(args.projectId)
  if (projectId) {
    if (!isUuid(projectId)) {
      throw new Error("Project ID is invalid.")
    }
    const { data, error } = await context.supabase
      .from("projects")
      .select("id")
      .eq("org_id", context.orgId)
      .eq("id", projectId)
      .maybeSingle()

    if (error) throw new Error(`Failed to validate project: ${error.message}`)
    if (!data?.id) throw new Error("Project was not found in your organization.")
    return data.id
  }

  const projectName = toOptionalText(args.projectName)
  if (!projectName) return null

  const { data, error } = await context.supabase
    .from("projects")
    .select("id,name,updated_at")
    .eq("org_id", context.orgId)
    .ilike("name", `%${projectName}%`)
    .order("updated_at", { ascending: false })
    .limit(5)

  if (error) throw new Error(`Failed to match project by name: ${error.message}`)

  const rows = Array.isArray(data) ? data : []
  if (rows.length === 0) {
    throw new Error(`No project matched "${projectName}".`)
  }

  const exact = rows.find((row) => row.name?.toLowerCase() === projectName.toLowerCase())
  if (exact?.id) return exact.id

  if (rows.length > 1) {
    throw new Error(`More than one project matched "${projectName}". Include the project ID for precision.`)
  }

  return rows[0]?.id ?? null
}

async function resolveAssigneeId(context: OrgServiceContext, args: Record<string, unknown>): Promise<string | null> {
  const assigneeId = toOptionalText(args.assigneeId)
  if (assigneeId) {
    if (!isUuid(assigneeId)) {
      throw new Error("Assignee ID is invalid.")
    }
    const { data, error } = await context.supabase
      .from("memberships")
      .select("user_id")
      .eq("org_id", context.orgId)
      .eq("user_id", assigneeId)
      .eq("status", "active")
      .maybeSingle()
    if (error) throw new Error(`Failed to validate assignee: ${error.message}`)
    if (!data?.user_id) throw new Error("Assignee is not an active member of this organization.")
    return data.user_id
  }

  const assigneeHint = toOptionalText(args.assigneeHint)
  if (!assigneeHint) return null

  const { data, error } = await context.supabase
    .from("memberships")
    .select("user_id, app_users!inner(id,full_name,email)")
    .eq("org_id", context.orgId)
    .eq("status", "active")
    .limit(200)

  if (error) throw new Error(`Failed to resolve assignee: ${error.message}`)

  const normalizedHint = assigneeHint.toLowerCase()
  const rows = (Array.isArray(data) ? data : []).filter((row) => {
    const profile = toRecord((row as { app_users?: unknown }).app_users)
    const fullName = toOptionalText(profile.full_name)?.toLowerCase()
    const email = toOptionalText(profile.email)?.toLowerCase()
    return Boolean(fullName?.includes(normalizedHint) || email?.includes(normalizedHint))
  })

  if (rows.length === 0) {
    throw new Error(`No active teammate matched "${assigneeHint}".`)
  }

  const exact = rows.find((row) => {
    const profile = toRecord((row as { app_users?: unknown }).app_users)
    const fullName = toOptionalText(profile.full_name)?.toLowerCase()
    const email = toOptionalText(profile.email)?.toLowerCase()
    return fullName === normalizedHint || email === normalizedHint
  })
  if (exact?.user_id) return exact.user_id

  if (rows.length > 1) {
    throw new Error(`Multiple teammates matched "${assigneeHint}". Provide an assignee ID to disambiguate.`)
  }

  return rows[0]?.user_id ?? null
}

async function executeCreateTaskAction(
  context: OrgServiceContext,
  rawArgs: Record<string, unknown>,
  options: { dryRun?: boolean } = {},
): Promise<ActionExecutionOutput> {
  const args = parseActionArgs(rawArgs)
  const title = toOptionalText(args.title)
  if (!title) {
    throw new Error("Task title is required.")
  }

  const [projectId, assigneeId] = await Promise.all([resolveProjectId(context, args), resolveAssigneeId(context, args)])
  const dueDate = toOptionalDate(args.dueDate)
  const description = toOptionalText(args.description) ?? null

  if (options.dryRun) {
    return {
      summary: `Preview: task "${title}"${dueDate ? ` due ${dueDate}` : ""}${projectId ? " with project scope" : ""}${
        assigneeId ? " and assignee" : ""
      } is valid and ready to execute.`,
      result: {
        preview: true,
        title,
        projectId,
        dueDate: dueDate ?? null,
        assignedTo: assigneeId ?? null,
        description,
      },
    }
  }

  const { data: task, error: taskError } = await context.supabase
    .from("tasks")
    .insert({
      org_id: context.orgId,
      project_id: projectId,
      title,
      description,
      status: "todo",
      priority: "normal",
      due_date: dueDate ?? null,
      created_by: context.userId,
      assigned_by: assigneeId ? context.userId : null,
    })
    .select("id,title,project_id,due_date")
    .single()

  if (taskError || !task) {
    throw new Error(`Failed to create task: ${taskError?.message ?? "Unknown error"}`)
  }

  if (assigneeId) {
    const { error: assignmentError } = await context.supabase.from("task_assignments").insert({
      org_id: context.orgId,
      task_id: task.id,
      user_id: assigneeId,
      assigned_by: context.userId,
      due_date: dueDate ?? null,
    })
    if (assignmentError) {
      throw new Error(`Task created, but assignment failed: ${assignmentError.message}`)
    }
  }

  return {
    summary: `Created task "${task.title}"${dueDate ? ` due ${dueDate}` : ""}.`,
    href: `/tasks/${task.id}`,
    result: {
      taskId: task.id,
      title: task.title,
      projectId: task.project_id ?? null,
      dueDate: task.due_date ?? null,
      assignedTo: assigneeId ?? null,
    },
  }
}

async function validateConversationId(context: OrgServiceContext, conversationId: string): Promise<ConversationLookupRow | null> {
  const { data, error } = await context.supabase
    .from("conversations")
    .select("id,subject,project_id,channel,projects(name),companies:audience_company_id(name)")
    .eq("org_id", context.orgId)
    .eq("id", conversationId)
    .maybeSingle()
  if (error) throw new Error(`Failed to validate conversation: ${error.message}`)
  return (data as ConversationLookupRow | null) ?? null
}

async function resolveConversation(context: OrgServiceContext, args: Record<string, unknown>) {
  const explicitConversationId = toOptionalText(args.conversationId)
  if (explicitConversationId) {
    if (!isUuid(explicitConversationId)) {
      throw new Error("Conversation ID is invalid.")
    }
    const direct = await validateConversationId(context, explicitConversationId)
    if (!direct) throw new Error("Conversation was not found in your organization.")
    return direct
  }

  const projectId = await resolveProjectId(context, args).catch(() => null)
  const projectNameHint = toOptionalText(args.projectName)?.toLowerCase()
  const recipientHint = toOptionalText(args.recipientHint)?.toLowerCase()

  let query = context.supabase
    .from("conversations")
    .select("id,subject,project_id,channel,last_message_at,created_at,projects(name),companies:audience_company_id(name)")
    .eq("org_id", context.orgId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(40)

  if (projectId) {
    query = query.eq("project_id", projectId)
  }

  const { data, error } = await query
  if (error) throw new Error(`Failed to resolve conversation: ${error.message}`)

  const rows = Array.isArray(data) ? (data as ConversationLookupRow[]) : []
  if (rows.length === 0) {
    throw new Error("No conversation matched this action request.")
  }

  const scored = rows
    .map((row) => {
      const subject = toOptionalText(row.subject)?.toLowerCase() ?? ""
      const projectName = toOptionalText((row.projects ?? {}).name)?.toLowerCase() ?? ""
      const companyName = toOptionalText((row.companies ?? {}).name)?.toLowerCase() ?? ""
      let score = 0
      if (recipientHint && (subject.includes(recipientHint) || companyName.includes(recipientHint))) score += 3
      if (projectNameHint && projectName.includes(projectNameHint)) score += 2
      if (projectId && row.project_id === projectId) score += 2
      return { row, score }
    })
    .sort((a, b) => b.score - a.score)

  const top = scored[0]
  if (!top) throw new Error("No conversation matched this action request.")

  if (top.score === 0 && scored.length > 1) {
    throw new Error("Conversation is ambiguous. Include conversation ID or recipient in your request.")
  }
  if (scored.length > 1 && scored[1]?.score === top.score && top.score > 0) {
    throw new Error("More than one conversation matched. Include conversation ID for precision.")
  }

  return top.row
}

async function executeSendMessageAction(
  context: OrgServiceContext,
  rawArgs: Record<string, unknown>,
  options: { dryRun?: boolean } = {},
): Promise<ActionExecutionOutput> {
  const args = parseActionArgs(rawArgs)
  const body = toOptionalText(args.body)
  if (!body) throw new Error("Message body is required.")
  if (body.length > MAX_ACTION_TEXT_LENGTH) {
    throw new Error(`Message body is too long. Keep it under ${MAX_ACTION_TEXT_LENGTH} characters.`)
  }

  const conversation = await resolveConversation(context, args)

  if (options.dryRun) {
    return {
      summary: `Preview: message is valid and would be sent to conversation "${conversation.subject ?? conversation.id}".`,
      result: {
        preview: true,
        conversationId: conversation.id,
        conversationSubject: conversation.subject ?? null,
        body,
      },
    }
  }

  const sent = await postConversationMessageWithClient({
    supabase: context.supabase,
    orgId: context.orgId,
    conversationId: conversation.id,
    body,
    senderId: context.userId,
  })

  return {
    summary: "Message sent successfully.",
    href: `/messages`,
    result: {
      messageId: sent.id,
      conversationId: conversation.id,
      conversationSubject: conversation.subject ?? null,
      body,
    },
  }
}

async function executeActionTool(
  context: OrgServiceContext,
  toolKey: string,
  args: Record<string, unknown>,
  options: { dryRun?: boolean } = {},
): Promise<ActionExecutionOutput> {
  switch (toolKey) {
    case "tasks.create":
      return executeCreateTaskAction(context, args, options)
    case "messages.send":
      return executeSendMessageAction(context, args, options)
    default:
      throw new Error(`Unsupported action tool: ${toolKey}`)
  }
}

const ACTION_COLUMNS = [
  "id",
  "tool_key",
  "title",
  "summary",
  "status",
  "requires_approval",
  "args",
  "result",
  "error",
  "created_at",
  "updated_at",
  "executed_at",
].join(",")

export async function createAiSearchActionRequest(
  context: OrgServiceContext,
  input: CreateAiSearchActionRequestInput,
): Promise<AiSearchAction> {
  if (!isAiActionToolKey(input.toolKey)) {
    throw new Error(`Unsupported action tool: ${input.toolKey}`)
  }

  const normalizedArgs = parseActionArgs(input.args)
  const dedupeFingerprint = stableSerialize({
    toolKey: input.toolKey,
    args: normalizedArgs,
    title: normalizeActionText(input.title, 220),
    summary: normalizeActionText(input.summary, 600),
  })

  const { data: pendingRows } = await context.supabase
    .from("ai_search_action_requests")
    .select(ACTION_COLUMNS)
    .eq("org_id", context.orgId)
    .eq("user_id", context.userId)
    .eq("tool_key", input.toolKey)
    .eq("status", "proposed")
    .order("created_at", { ascending: false })
    .limit(20)

  if (Array.isArray(pendingRows)) {
    for (const row of pendingRows as unknown as Array<Record<string, unknown>>) {
      const existingFingerprint = stableSerialize({
        toolKey: typeof row.tool_key === "string" ? row.tool_key : "",
        args: parseActionArgs(row.args),
        title: normalizeActionText(typeof row.title === "string" ? row.title : "", 220),
        summary: normalizeActionText(typeof row.summary === "string" ? row.summary : "", 600),
      })
      if (existingFingerprint === dedupeFingerprint) {
        return mapActionRow(row as any)
      }
    }
  }

  const { data, error } = await context.supabase
    .from("ai_search_action_requests")
    .insert({
      org_id: context.orgId,
      user_id: context.userId,
      session_id: input.sessionId ?? null,
      tool_key: input.toolKey,
      title: normalizeActionText(input.title, 220),
      summary: normalizeActionText(input.summary, 600),
      args: normalizedArgs,
      requires_approval: input.requiresApproval ?? true,
      status: "proposed",
    })
    .select(ACTION_COLUMNS)
    .single()

  if (error || !data) {
    const message = error?.message ?? "Unknown error"
    if (message.toLowerCase().includes("ai_search_action_requests")) {
      throw new Error("Action queue is unavailable. Apply migration 20260306102000_ai_search_actions_queue.sql.")
    }
    throw new Error(`Failed to create action request: ${message}`)
  }

  return mapActionRow(data)
}

export async function executeAiSearchActionRequest(
  context: OrgServiceContext,
  actionId: string,
  options: ExecuteAiSearchActionRequestOptions = {},
): Promise<AiSearchAction> {
  const targetId = toOptionalText(actionId)
  if (!targetId || !isUuid(targetId)) {
    throw new Error("A valid action ID is required.")
  }
  const dryRun = options.dryRun === true
  const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey)

  const { data: existing, error: loadError } = await context.supabase
    .from("ai_search_action_requests")
    .select(ACTION_COLUMNS)
    .eq("id", targetId)
    .eq("org_id", context.orgId)
    .eq("user_id", context.userId)
    .single()

  if (loadError || !existing) {
    throw new Error("Action request was not found.")
  }

  const existingAction = mapActionRow(existing as any)
  const createdAtMs = Number.isFinite(new Date(existingAction.createdAt).getTime())
    ? new Date(existingAction.createdAt).getTime()
    : Date.now()
  if (Date.now() - createdAtMs > ACTION_STALE_WINDOW_MS && existingAction.status === "proposed") {
    throw new Error("Action request expired for safety. Regenerate the action from the assistant.")
  }

  if (existingAction.status === "executed") {
    const existingIdempotency = extractActionIdempotencyKey(existingAction)
    if (idempotencyKey && existingIdempotency && existingIdempotency !== idempotencyKey) {
      throw new Error("Action was already executed with a different idempotency key.")
    }
    return existingAction
  }
  if (existingAction.status === "running") {
    const runningStartedAtMs = resolveRunningStartedAtMs(existingAction)
    if (runningStartedAtMs !== null && Date.now() - runningStartedAtMs > ACTION_STALE_WINDOW_MS) {
      const staleMessage =
        "Action execution timed out before completion. Please regenerate the action and run it again."
      const { data: staleRow, error: staleError } = await context.supabase
        .from("ai_search_action_requests")
        .update({
          status: "failed",
          error: staleMessage,
          result: compactObject({
            ...existingAction.result,
            timedOut: true,
          }),
        })
        .eq("id", targetId)
        .eq("org_id", context.orgId)
        .eq("user_id", context.userId)
        .eq("status", "running")
        .select(ACTION_COLUMNS)
        .maybeSingle()

      if (staleRow) {
        return mapActionRow(staleRow)
      }
      if (staleError) {
        throw new Error(`Failed to resolve stale running action: ${staleError.message}`)
      }
    }

    const existingIdempotency = extractActionIdempotencyKey(existingAction)
    if (!idempotencyKey || !existingIdempotency || existingIdempotency === idempotencyKey) {
      return existingAction
    }
    throw new Error("Action is already running under a different idempotency key.")
  }
  if (existingAction.status !== "proposed") {
    throw new Error(`Action cannot be executed from status "${existingAction.status}".`)
  }

  if (dryRun) {
    const preview = await executeActionTool(context, existingAction.toolKey, existingAction.args, { dryRun: true })
    return {
      ...existingAction,
      result: compactObject({
        ...existingAction.result,
        preview: true,
        summary: preview.summary,
        ...(preview.result ?? {}),
      }),
      error: undefined,
    }
  }

  const claimedAtIso = new Date().toISOString()
  const claimResult = compactObject({
    ...existingAction.result,
    idempotencyKey: idempotencyKey ?? null,
    runningStartedAt: claimedAtIso,
  })
  const { data: claimedRow, error: claimError } = await context.supabase
    .from("ai_search_action_requests")
    .update({
      status: "running",
      result: claimResult,
      error: null,
    })
    .eq("id", targetId)
    .eq("org_id", context.orgId)
    .eq("user_id", context.userId)
    .eq("status", "proposed")
    .select(ACTION_COLUMNS)
    .maybeSingle()

  if (claimError) {
    throw new Error(`Failed to claim action request: ${claimError.message}`)
  }

  const claimedAction = claimedRow ? mapActionRow(claimedRow) : null
  if (!claimedAction) {
    const { data: latestRow, error: latestError } = await context.supabase
      .from("ai_search_action_requests")
      .select(ACTION_COLUMNS)
      .eq("id", targetId)
      .eq("org_id", context.orgId)
      .eq("user_id", context.userId)
      .maybeSingle()

    if (latestError || !latestRow) {
      throw new Error("Unable to claim action request for execution.")
    }
    const latestAction = mapActionRow(latestRow)
    if (latestAction.status === "executed" || latestAction.status === "running") {
      return latestAction
    }
    throw new Error(`Action cannot be executed from status "${latestAction.status}".`)
  }

  try {
    const execution = await executeActionTool(context, claimedAction.toolKey, claimedAction.args, { dryRun: false })
    const { data: updated, error: updateError } = await context.supabase
      .from("ai_search_action_requests")
      .update({
        status: "executed",
        result: compactObject({
          ...(execution.result ?? {}),
          summary: execution.summary,
          href: execution.href,
          idempotencyKey: idempotencyKey ?? null,
        }),
        error: null,
        executed_at: new Date().toISOString(),
      })
      .eq("id", targetId)
      .eq("org_id", context.orgId)
      .eq("user_id", context.userId)
      .eq("status", "running")
      .select(ACTION_COLUMNS)
      .single()

    if (updateError || !updated) {
      throw new Error(`Action succeeded but status update failed: ${updateError?.message ?? "Unknown error"}`)
    }

    return mapActionRow(updated)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Action execution failed."
    const { data: failed, error: failedUpdateError } = await context.supabase
      .from("ai_search_action_requests")
      .update({
        status: "failed",
        error: message,
        result: {},
      })
      .eq("id", targetId)
      .eq("org_id", context.orgId)
      .eq("user_id", context.userId)
      .eq("status", "running")
      .select(ACTION_COLUMNS)
      .single()

    if (failedUpdateError || !failed) {
      throw new Error(message)
    }

    return mapActionRow(failed)
  }
}
