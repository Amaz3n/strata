export const PLATFORM_BUG_STATUSES = ["triage", "backlog", "todo", "in_progress", "in_review", "done", "wont_fix"] as const
export const PLATFORM_BUG_PRIORITIES = ["urgent", "high", "medium", "low"] as const

export type PlatformBugStatus = (typeof PLATFORM_BUG_STATUSES)[number]
export type PlatformBugPriority = (typeof PLATFORM_BUG_PRIORITIES)[number]

export type PlatformBugRef = { id: string; name: string }

export type PlatformBugPerson = {
  id: string
  full_name: string | null
  email: string | null
  avatar_url: string | null
}

export type PlatformBugAttachment = {
  id: string
  bug_id: string
  file_name: string
  content_type: string | null
  size_bytes: number | null
  created_at: string
  download_url: string
}

export type PlatformBug = {
  id: string
  issue_key: string
  title: string
  description: string | null
  status: PlatformBugStatus
  priority: PlatformBugPriority
  source: string
  environment: string | null
  org_id: string | null
  project_id: string | null
  expected_behavior: string | null
  actual_behavior: string | null
  assignee_user_id: string | null
  created_by: string | null
  updated_by: string | null
  due_at: string | null
  started_at: string | null
  resolved_at: string | null
  archived_at: string | null
  attachment_names: string[]
  attachments: PlatformBugAttachment[]
  created_at: string
  updated_at: string
  assignee?: PlatformBugPerson | null
  creator?: PlatformBugPerson | null
  org?: PlatformBugRef | null
  project?: PlatformBugRef | null
}

export type PlatformBugEvent = {
  id: string
  bug_id: string
  actor_user_id: string | null
  event_type: "created" | "status_changed" | "priority_changed" | "severity_changed" | "assignee_changed" | "commented" | "edited" | "archived"
  body: string | null
  from_value: string | null
  to_value: string | null
  created_at: string
  actor?: PlatformBugPerson | null
}

export type PlatformBugAiReviewStatus = "queued" | "dispatched" | "running" | "proposal_ready" | "failed" | "cancelled"
export type PlatformBugAiFixStatus = "queued" | "dispatched" | "running" | "pr_ready" | "failed" | "cancelled"

export type PlatformBugAiReview = {
  id: string
  bug_id: string
  status: PlatformBugAiReviewStatus
  provider: "codex"
  requested_by: string | null
  github_owner: string | null
  github_repo: string | null
  github_workflow: string | null
  github_ref: string | null
  github_run_id: string | null
  github_run_url: string | null
  summary: string | null
  proposal: Record<string, unknown>
  raw_output: string | null
  error: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export type PlatformBugAiFix = {
  id: string
  bug_id: string
  review_id: string | null
  status: PlatformBugAiFixStatus
  provider: "codex"
  requested_by: string | null
  github_owner: string | null
  github_repo: string | null
  github_workflow: string | null
  github_ref: string | null
  github_run_id: string | null
  github_run_url: string | null
  branch_name: string | null
  commit_sha: string | null
  pr_number: number | null
  pr_url: string | null
  summary: string | null
  raw_output: string | null
  error: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export type PlatformBugInput = {
  title: string
  description?: string | null
  status?: PlatformBugStatus
  priority?: PlatformBugPriority
  source?: string | null
  environment?: string | null
  orgId?: string | null
  projectId?: string | null
  expectedBehavior?: string | null
  actualBehavior?: string | null
  assigneeUserId?: string | null
  dueAt?: string | null
  attachmentNames?: string[]
}

export type PlatformBugUpdate = Partial<Omit<PlatformBugInput, "title">> & {
  title?: string
}
