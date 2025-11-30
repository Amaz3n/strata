import type React from "react"
// Core domain types for Strata
// Following the spec: every tenant-owned row includes org_id

export interface Org {
  id: string
  name: string
  slug: string
  created_at: string
  updated_at: string
}

export interface User {
  id: string
  email: string
  full_name: string
  avatar_url?: string
}

export interface Membership {
  id: string
  user_id: string
  org_id: string
  role: OrgRole
  status: "active" | "invited" | "deactivated"
  created_at: string
}

export type OrgRole = "owner" | "admin" | "staff" | "readonly"
export type ProjectRole = "pm" | "field" | "accounting" | "client" | "sub"

export interface Project {
  id: string
  org_id: string
  name: string
  address?: string
  status: ProjectStatus
  start_date?: string
  end_date?: string
  budget?: number
  client_id?: string
  created_at: string
  updated_at: string
}

export type ProjectStatus = "planning" | "active" | "on_hold" | "completed" | "cancelled"

export type ConversationChannel = "internal" | "client" | "sub"

export interface Conversation {
  id: string
  org_id: string
  project_id?: string
  subject?: string | null
  channel: ConversationChannel
  created_by?: string
  created_at: string
}

export interface PortalMessage {
  id: string
  org_id: string
  conversation_id: string
  sender_id?: string
  message_type: string
  body?: string | null
  payload?: Record<string, any>
  sent_at: string
  sender_name?: string
  sender_avatar_url?: string
}

export interface Task {
  id: string
  org_id: string
  project_id: string
  title: string
  description?: string
  status: TaskStatus
  priority: TaskPriority
  assignee_id?: string
  due_date?: string
  created_at: string
  updated_at: string
}

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done"
export type TaskPriority = "low" | "normal" | "high" | "urgent"

export interface DailyLog {
  id: string
  org_id: string
  project_id: string
  date: string
  weather?: string
  notes?: string
  created_by?: string
  created_at: string
  updated_at: string
}

export interface ScheduleItem {
  id: string
  org_id: string
  project_id: string
  name: string
  item_type: string
  status: ScheduleStatus | string
  start_date?: string
  end_date?: string
  progress?: number
  assigned_to?: string
  metadata?: Record<string, any>
  created_at: string
  updated_at: string
  dependencies?: string[]
}

export type ScheduleStatus = "planned" | "in_progress" | "at_risk" | "completed" | "done" | "blocked" | "cancelled"

// Navigation types
export interface NavItem {
  title: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  badge?: number
}

export interface NavSection {
  title?: string
  items: NavItem[]
}

export interface PortalView {
  project: Project
  channel: ConversationChannel
  conversation: Conversation
  messages: PortalMessage[]
  recentLogs: DailyLog[]
  sharedFiles: FileMetadata[]
  schedule: ScheduleItem[]
}

export interface FileMetadata {
  id: string
  org_id: string
  project_id?: string
  file_name: string
  storage_path: string
  mime_type?: string
  size_bytes?: number
  visibility: string
  created_at: string
}

export interface DashboardStats {
  activeProjects: number
  tasksThisWeek: number
  pendingApprovals: number
  recentPhotos: number
}
