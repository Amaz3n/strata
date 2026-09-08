import type { DailyLog, DailyReport, ScheduleItem, Task } from "@/lib/types"
import type { EnhancedFileMetadata, FileCategory, ProjectPunchItem } from "@/app/(app)/projects/[id]/actions"
import type {
  DailyLogInput,
  DailyReportSectionInput,
  DailyReportSectionKind,
  DailyReportUpdateInput,
  ManpowerInput,
} from "@/lib/validation/daily-logs"
import type { MentionableUser } from "./mention-textarea"
import type { ProjectLocation } from "@/lib/services/locations"

export interface DailyLogsWorkspaceProps {
  userId: string
  selectedDate: string
  loading: boolean
  loadError?: string | null
  onSelectDate: (date: string) => void
  onRetry: () => void
  onLoadContext: () => Promise<void>
  contextLoading: boolean
  contextError?: string | null
  uploads: Array<{ id: string; name: string; status: string; error?: string }>
  onRetryUpload: (id: string) => void
  projectId: string
  projectAddress?: string
  projectStartDate?: string
  dailyLogs: DailyLog[]
  dailyReports: DailyReport[]
  files: EnhancedFileMetadata[]
  scheduleItems: ScheduleItem[]
  tasks: Task[]
  punchItems: ProjectPunchItem[]
  locations: ProjectLocation[]
  canManageLocations: boolean
  mentionableUsers: MentionableUser[]
  onUpdateReport: (date: string, values: DailyReportUpdateInput) => Promise<DailyReport>
  onSubmitReport: (reportId: string) => Promise<DailyReport>
  onReopenReport: (reportId: string) => Promise<DailyReport>
  onAddManpower: (date: string, values: ManpowerInput) => Promise<DailyReport>
  onUpdateManpower: (manpowerId: string, values: ManpowerInput) => Promise<DailyReport>
  onDeleteManpower: (manpowerId: string) => Promise<DailyReport>
  onAddSection: (date: string, kind: DailyReportSectionKind, input: DailyReportSectionInput) => Promise<DailyReport>
  onUpdateSection: (kind: DailyReportSectionKind, id: string, input: DailyReportSectionInput) => Promise<DailyReport>
  onDeleteSection: (kind: DailyReportSectionKind, id: string) => Promise<DailyReport>
  onRefreshWeather: (reportId: string) => Promise<DailyReport>
  onCreateLog: (values: DailyLogInput) => Promise<DailyLog>
  onCreateComment: (
    dailyLogId: string,
    values: { body: string; mentioned_user_ids?: string[] },
  ) => Promise<NonNullable<DailyLog["comments"]>[number]>
  onUpdateLog: (
    dailyLogId: string,
    values: { summary?: string; weather?: string; mentioned_user_ids?: string[] },
  ) => Promise<Pick<DailyLog, "id" | "notes" | "weather" | "updated_at" | "mentions">>
  onUploadFiles: (
    files: File[],
    context?: { category?: FileCategory; dailyLogId?: string; scheduleItemId?: string; tags?: string[] },
  ) => Promise<void>
  onDownloadFile: (file: EnhancedFileMetadata) => Promise<void>
  onDeleteLog?: (dailyLogId: string) => Promise<void>
}
