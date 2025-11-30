import type { Project, Task, DailyLog, User } from "./types"

// Mock current user
export const currentUser: User = {
  id: "user-1",
  email: "mike@localbuilder.com",
  full_name: "Mike Thompson",
  avatar_url: "/construction-manager-headshot.png",
}

// Mock projects
export const projects: Project[] = [
  {
    id: "proj-1",
    org_id: "org-1",
    name: "Harrison Kitchen Remodel",
    address: "1245 Oak Street, Portland",
    status: "active",
    start_date: "2024-01-15",
    end_date: "2024-04-30",
    budget: 85000,
    client_id: "contact-1",
    created_at: "2024-01-10T00:00:00Z",
    updated_at: "2024-01-20T00:00:00Z",
  },
  {
    id: "proj-2",
    org_id: "org-1",
    name: "Westside Addition",
    address: "892 Pine Avenue, Seattle",
    status: "active",
    start_date: "2024-02-01",
    end_date: "2024-08-15",
    budget: 245000,
    client_id: "contact-2",
    created_at: "2024-01-25T00:00:00Z",
    updated_at: "2024-02-05T00:00:00Z",
  },
  {
    id: "proj-3",
    org_id: "org-1",
    name: "Downtown Office TI",
    address: "500 Main Street, Suite 200",
    status: "planning",
    start_date: "2024-03-01",
    budget: 125000,
    client_id: "contact-3",
    created_at: "2024-02-10T00:00:00Z",
    updated_at: "2024-02-10T00:00:00Z",
  },
  {
    id: "proj-4",
    org_id: "org-1",
    name: "Smith Bathroom Renovation",
    address: "723 Elm Court, Bellevue",
    status: "completed",
    start_date: "2023-11-01",
    end_date: "2024-01-05",
    budget: 32000,
    client_id: "contact-4",
    created_at: "2023-10-20T00:00:00Z",
    updated_at: "2024-01-05T00:00:00Z",
  },
]

// Mock tasks
export const tasks: Task[] = [
  {
    id: "task-1",
    org_id: "org-1",
    project_id: "proj-1",
    title: "Final electrical inspection",
    description: "Schedule and complete final electrical inspection with city",
    status: "todo",
    priority: "high",
    assignee_id: "user-2",
    due_date: "2024-02-15",
    created_at: "2024-02-01T00:00:00Z",
    updated_at: "2024-02-01T00:00:00Z",
  },
  {
    id: "task-2",
    org_id: "org-1",
    project_id: "proj-1",
    title: "Install cabinet hardware",
    status: "in_progress",
    priority: "medium",
    assignee_id: "user-1",
    due_date: "2024-02-12",
    created_at: "2024-02-01T00:00:00Z",
    updated_at: "2024-02-08T00:00:00Z",
  },
  {
    id: "task-3",
    org_id: "org-1",
    project_id: "proj-2",
    title: "Pour foundation footings",
    status: "done",
    priority: "high",
    assignee_id: "user-3",
    due_date: "2024-02-05",
    created_at: "2024-01-28T00:00:00Z",
    updated_at: "2024-02-04T00:00:00Z",
  },
  {
    id: "task-4",
    org_id: "org-1",
    project_id: "proj-2",
    title: "Frame exterior walls",
    status: "in_progress",
    priority: "high",
    assignee_id: "user-3",
    due_date: "2024-02-20",
    created_at: "2024-02-01T00:00:00Z",
    updated_at: "2024-02-10T00:00:00Z",
  },
  {
    id: "task-5",
    org_id: "org-1",
    project_id: "proj-1",
    title: "Client walkthrough",
    status: "todo",
    priority: "medium",
    due_date: "2024-02-18",
    created_at: "2024-02-05T00:00:00Z",
    updated_at: "2024-02-05T00:00:00Z",
  },
]

// Mock daily logs
export const dailyLogs: DailyLog[] = [
  {
    id: "log-1",
    org_id: "org-1",
    project_id: "proj-1",
    date: "2024-02-10",
    weather: "Cloudy, 48°F",
    notes:
      "Cabinet installation completed. Electrician on site for final hookups. Minor delay due to missing trim pieces - ordered, arriving Tuesday.",
    created_by: "user-1",
    created_at: "2024-02-10T17:00:00Z",
    updated_at: "2024-02-10T17:00:00Z",
  },
  {
    id: "log-2",
    org_id: "org-1",
    project_id: "proj-2",
    date: "2024-02-10",
    weather: "Rain, 52°F",
    notes: "Rain delay - no exterior work. Crew worked on interior framing. 4 carpenters on site, 6 hours each.",
    created_by: "user-1",
    created_at: "2024-02-10T16:30:00Z",
    updated_at: "2024-02-10T16:30:00Z",
  },
]

// Dashboard stats
export const dashboardStats = {
  activeProjects: 3,
  tasksThisWeek: 12,
  pendingApprovals: 4,
  recentPhotos: 28,
}

// Recent activity
export const recentActivity = [
  {
    id: "act-1",
    type: "task_completed",
    message: "Foundation footings poured",
    project: "Westside Addition",
    timestamp: "2 hours ago",
  },
  {
    id: "act-2",
    type: "photo_uploaded",
    message: "6 photos added",
    project: "Harrison Kitchen Remodel",
    timestamp: "4 hours ago",
  },
  {
    id: "act-3",
    type: "daily_log",
    message: "Daily log submitted",
    project: "Westside Addition",
    timestamp: "5 hours ago",
  },
  {
    id: "act-4",
    type: "change_order",
    message: "CO #003 pending approval",
    project: "Harrison Kitchen Remodel",
    timestamp: "Yesterday",
  },
  {
    id: "act-5",
    type: "schedule_update",
    message: "Inspection scheduled for Feb 15",
    project: "Harrison Kitchen Remodel",
    timestamp: "Yesterday",
  },
]
