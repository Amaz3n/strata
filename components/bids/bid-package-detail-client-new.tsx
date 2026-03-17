"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { format, formatDistanceToNow, isPast } from "date-fns"
import { toast } from "sonner"

import type { Company, ProjectVendor } from "@/lib/types"
import type { BidAddendum, BidInvite, BidPackage, BidSubmission } from "@/lib/services/bids"
import type { BidPackageStatus } from "@/lib/validation/bids"
import { cn } from "@/lib/utils"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetFooter,
  SheetClose,
} from "@/components/ui/sheet"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import { formatFileSize, getMimeIcon, isPreviewable } from "@/components/files/types"
import { FileViewer } from "@/components/files/file-viewer"
import {
  attachFileAction,
  detachFileLinkAction,
  listFilesAction,
  listFoldersAction,
  listAttachmentsAction,
  uploadFileAction,
} from "@/app/(app)/files/actions"
import type { FileWithUrls } from "@/app/(app)/files/actions"
import {
  createBidAddendumAction,
  bulkCreateBidInvitesAction,
  generateBidInviteLinkAction,
  pauseBidInviteAccessAction,
  resumeBidInviteAccessAction,
  revokeBidInviteAccessAction,
  setBidInviteRequireAccountAction,
  pauseBidInviteAccountGrantsAction,
  resumeBidInviteAccountGrantsAction,
  revokeBidInviteAccountGrantsAction,
  listBidInvitesAction,
  awardBidSubmissionAction,
  updateBidPackageAction,
} from "@/app/(app)/projects/[id]/bids/actions"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { CalendarDays } from "@/components/icons"
import {
  Ban,
  Building2,
  CheckCircle2,
  Copy,
  Download,
  Edit,
  Eye,
  FileText,
  Loader2,
  Mail,
  MoreHorizontal,
  FolderOpen,
  Plus,
  Search,
  Shield,
  Settings,
  Sparkles,
  Trash2,
  TrendingDown,
  TrendingUp,
  Trophy,
  Upload,
  Users,
  X,
} from "lucide-react"

const statusOptions: BidPackageStatus[] = ["draft", "sent", "open", "closed", "awarded", "cancelled"]
const NO_TRADE_VALUE = "__none__"

function normalizeTrade(value?: string | null): string {
  return value?.trim().toLowerCase() ?? ""
}

function splitTradeTokens(value?: string | null): string[] {
  const normalized = normalizeTrade(value)
  if (!normalized) return []
  return normalized
    .split(/[,/&+|;]|(?:\band\b)|(?:\bor\b)/g)
    .map((token) => token.trim())
    .filter(Boolean)
}

function matchesTradeFilter(value: string | null | undefined, tradeFilter: string): boolean {
  const normalizedValue = normalizeTrade(value)
  if (!normalizedValue) return false
  if (normalizedValue === tradeFilter) return true
  if (normalizedValue.includes(tradeFilter) || tradeFilter.includes(normalizedValue)) return true

  const tokens = splitTradeTokens(value)
  return tokens.some((token) => token === tradeFilter || token.includes(tradeFilter) || tradeFilter.includes(token))
}

type BidPackageAttachment = AttachedFile & { folder_path?: string | null }

interface AttachmentFolderNode {
  id: string
  name: string
  path: string
  files: BidPackageAttachment[]
  children: AttachmentFolderNode[]
}

function normalizeFolderPath(value?: string | null): string {
  if (!value) return ""
  const trimmed = value.trim()
  if (!trimmed) return ""
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  return withLeadingSlash.replace(/\/+/g, "/").replace(/\/$/, "")
}

function countNodeFiles(node: AttachmentFolderNode): number {
  return node.files.length + node.children.reduce((sum, child) => sum + countNodeFiles(child), 0)
}

function buildAttachmentFolderTree(attachments: BidPackageAttachment[]): AttachmentFolderNode {
  const root: AttachmentFolderNode = {
    id: "root",
    name: "root",
    path: "",
    files: [],
    children: [],
  }

  for (const attachment of attachments) {
    const normalizedPath = normalizeFolderPath(attachment.folder_path)
    if (!normalizedPath) {
      root.files.push(attachment)
      continue
    }

    const parts = normalizedPath.split("/").filter(Boolean)
    let current = root
    let runningPath = ""

    for (const part of parts) {
      runningPath = `${runningPath}/${part}`
      let child = current.children.find((node) => node.path === runningPath)
      if (!child) {
        child = {
          id: runningPath,
          name: part,
          path: runningPath,
          files: [],
          children: [],
        }
        current.children.push(child)
      }
      current = child
    }

    current.files.push(attachment)
  }

  const sortNode = (node: AttachmentFolderNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name))
    node.files.sort((a, b) => a.file_name.localeCompare(b.file_name))
    node.children.forEach(sortNode)
  }
  sortNode(root)

  return root
}

function mapAttachments(links: any[]): BidPackageAttachment[] {
  return (links ?? []).map((link) => ({
    id: link.file.id,
    linkId: link.id,
    file_name: link.file.file_name,
    mime_type: link.file.mime_type,
    size_bytes: link.file.size_bytes,
    download_url: link.file.download_url,
    thumbnail_url: link.file.thumbnail_url,
    created_at: link.created_at,
    link_role: link.link_role,
    folder_path: link.file.folder_path ?? null,
  }))
}

function formatCurrency(cents: number | null | undefined): string {
  if (cents == null) return "—"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function getVendorStatusInfo(invite: BidInvite, submission?: BidSubmission | null): {
  status: string
  color: string
  activity: string
} {
  if (submission?.status === "submitted" && submission.is_current) {
    return {
      status: "Submitted",
      color: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
      activity: submission.submitted_at
        ? `Submitted ${formatDistanceToNow(new Date(submission.submitted_at), { addSuffix: true })}`
        : "Submitted",
    }
  }

  switch (invite.status) {
    case "submitted":
      return {
        status: "Submitted",
        color: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
        activity: invite.submitted_at
          ? `Submitted ${formatDistanceToNow(new Date(invite.submitted_at), { addSuffix: true })}`
          : "Submitted",
      }
    case "viewed":
      return {
        status: "Viewed",
        color: "bg-violet-500/15 text-violet-600 border-violet-500/30",
        activity: invite.last_viewed_at
          ? `Viewed ${formatDistanceToNow(new Date(invite.last_viewed_at), { addSuffix: true })}`
          : "Viewed",
      }
    case "declined":
      return {
        status: "Declined",
        color: "bg-rose-500/15 text-rose-600 border-rose-500/30",
        activity: invite.declined_at
          ? `Declined ${formatDistanceToNow(new Date(invite.declined_at), { addSuffix: true })}`
          : "Declined",
      }
    case "sent":
      return {
        status: "Invited",
        color: "bg-blue-500/15 text-blue-600 border-blue-500/30",
        activity: invite.sent_at
          ? `Sent ${formatDistanceToNow(new Date(invite.sent_at), { addSuffix: true })}`
          : "Awaiting response",
      }
    case "draft":
      return {
        status: "Draft",
        color: "bg-muted text-muted-foreground border-muted",
        activity: "Not sent yet",
      }
    default:
      return {
        status: invite.status,
        color: "bg-muted text-muted-foreground border-muted",
        activity: "—",
      }
  }
}

function getInviteAccessSummary(invite: BidInvite): { label: string; color: string } {
  const active = invite.active_access_count ?? 0
  const paused = invite.paused_access_count ?? 0
  const total = invite.access_total ?? 0

  if (active > 0) return { label: `${active} active link${active === 1 ? "" : "s"}`, color: "text-emerald-600" }
  if (paused > 0) return { label: `${paused} paused link${paused === 1 ? "" : "s"}`, color: "text-amber-600" }
  if (total > 0) return { label: "Links revoked", color: "text-rose-600" }
  return { label: "No link generated", color: "text-muted-foreground" }
}

type PriceIntelligenceSignal = "pending" | "insufficient_data" | "in_range" | "below_range" | "above_range"

function getPriceIntelligenceSummary(submission?: BidSubmission | null): {
  signal: PriceIntelligenceSignal
  label: string
  compactLabel: string
  textClass: string
  badgeClass: string
  message: string
} {
  const benchmark = submission?.benchmark
  if (!benchmark) {
    return {
      signal: "pending",
      label: "Benchmark pending",
      compactLabel: "Pending",
      textClass: "text-muted-foreground",
      badgeClass: "border-border bg-muted text-muted-foreground",
      message: "Arc Intelligence is preparing a private market benchmark for this submission.",
    }
  }

  if (!benchmark.has_benchmark || benchmark.signal === "insufficient_data") {
    return {
      signal: "insufficient_data",
      label: "Insufficient market data",
      compactLabel: "Insufficient data",
      textClass: "text-muted-foreground",
      badgeClass: "border-border bg-muted text-muted-foreground",
      message: benchmark.message ?? "Not enough similar bids yet to produce a benchmark.",
    }
  }

  if (benchmark.signal === "in_range") {
    return {
      signal: "in_range",
      label: "In market range",
      compactLabel: "In range",
      textClass: "text-emerald-700 dark:text-emerald-400",
      badgeClass: "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
      message: benchmark.message ?? "This bid is within the typical market range.",
    }
  }

  if (benchmark.signal === "below_range") {
    return {
      signal: "below_range",
      label: "Below market range",
      compactLabel: "Below range",
      textClass: "text-amber-700 dark:text-amber-400",
      badgeClass: "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300",
      message: benchmark.message ?? "This bid is below the typical market range.",
    }
  }

  return {
    signal: "above_range",
    label: "Above market range",
    compactLabel: "Above range",
    textClass: "text-rose-700 dark:text-rose-400",
    badgeClass: "border-rose-500/30 bg-rose-500/15 text-rose-700 dark:text-rose-300",
    message: benchmark.message ?? "This bid is above the typical market range.",
  }
}

function getMatchLevelLabel(matchLevel?: string | null): string {
  switch (matchLevel) {
    case "strict":
      return "Strict match"
    case "trade_type_size":
      return "Trade + type + size"
    case "trade_and_type":
      return "Trade + type"
    case "trade_type_family":
      return "Trade + type family"
    case "trade_only":
      return "Trade only"
    default:
      return "No match level"
  }
}

function getBenchmarkConfidence(benchmark?: BidSubmission["benchmark"]): { label: string; badgeClass: string } {
  if (!benchmark || !benchmark.has_benchmark || benchmark.signal === "insufficient_data") {
    return {
      label: "Unavailable confidence",
      badgeClass: "border-border bg-muted text-muted-foreground",
    }
  }

  if (benchmark.match_level === "strict" || benchmark.match_level === "trade_type_size") {
    return {
      label: "High confidence",
      badgeClass: "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    }
  }

  if (benchmark.match_level === "trade_and_type" || benchmark.match_level === "trade_type_family") {
    return {
      label: "Medium confidence",
      badgeClass: "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300",
    }
  }

  return {
    label: "Low confidence",
    badgeClass: "border-rose-500/30 bg-rose-500/15 text-rose-700 dark:text-rose-300",
  }
}

function computeMedian(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2
  }
  return sorted[middle]
}

function formatDeviationPercent(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—"
  const rounded = Number(value.toFixed(1))
  if (rounded === 0) return "0%"
  const sign = rounded > 0 ? "+" : ""
  return `${sign}${rounded}%`
}

interface BidPackageDetailClientProps {
  projectId: string
  bidPackage: BidPackage
  invites: BidInvite[]
  addenda: BidAddendum[]
  submissions: BidSubmission[]
  companies: Company[]
  projectVendors: ProjectVendor[]
}

export function BidPackageDetailClientNew({
  projectId,
  bidPackage,
  invites,
  addenda,
  submissions,
  companies,
  projectVendors,
}: BidPackageDetailClientProps) {
  // Core state
  const [current, setCurrent] = useState(bidPackage)
  const [inviteList, setInviteList] = useState(invites)
  const [addendumList, setAddendumList] = useState(addenda)
  const [submissionList, setSubmissionList] = useState(submissions)

  // Edit form state
  const [title, setTitle] = useState(bidPackage.title)
  const [trade, setTrade] = useState(bidPackage.trade?.trim() || NO_TRADE_VALUE)
  const [dueAt, setDueAt] = useState<Date | undefined>(
    bidPackage.due_at ? new Date(bidPackage.due_at) : undefined
  )
  const [status, setStatus] = useState<BidPackageStatus>(bidPackage.status)
  const [scope, setScope] = useState(bidPackage.scope ?? "")
  const [instructions, setInstructions] = useState(bidPackage.instructions ?? "")

  // Invite form state
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set())
  const [companySearch, setCompanySearch] = useState("")
  const [sendEmails, setSendEmails] = useState(true)
  const [tradeFilter, setTradeFilter] = useState<string>(normalizeTrade(bidPackage.trade) || "all")
  const [emailInvites, setEmailInvites] = useState<Array<{ email: string; companyName: string }>>([])
  const [newEmailInput, setNewEmailInput] = useState("")
  const [newCompanyNameInput, setNewCompanyNameInput] = useState("")

  // Addendum form state
  const [addendumTitle, setAddendumTitle] = useState("")
  const [addendumMessage, setAddendumMessage] = useState("")

  // Attachments state
  const [packageAttachments, setPackageAttachments] = useState<BidPackageAttachment[]>([])
  const [addendumAttachments, setAddendumAttachments] = useState<Record<string, AttachedFile[]>>({})
  const [submissionAttachments, setSubmissionAttachments] = useState<Record<string, AttachedFile[]>>({})
  const [isLoadingSubmissionAttachments, setIsLoadingSubmissionAttachments] = useState(false)
  const [projectFiles, setProjectFiles] = useState<FileWithUrls[]>([])
  const [projectFolders, setProjectFolders] = useState<string[]>([])
  const [projectFileSearch, setProjectFileSearch] = useState("")
  const [projectFolderFilter, setProjectFolderFilter] = useState("all")
  const [selectedProjectFileIds, setSelectedProjectFileIds] = useState<Set<string>>(new Set())
  const [isLoadingProjectFiles, setIsLoadingProjectFiles] = useState(false)

  // UI state
  const [editSheetOpen, setEditSheetOpen] = useState(false)
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false)
  const [addendumDialogOpen, setAddendumDialogOpen] = useState(false)
  const [awardDialogOpen, setAwardDialogOpen] = useState(false)
  const [selectedSubmission, setSelectedSubmission] = useState<BidSubmission | null>(null)
  const [submissionSheetOpen, setSubmissionSheetOpen] = useState(false)
  const [detailSubmission, setDetailSubmission] = useState<BidSubmission | null>(null)
  const [projectFilesSheetOpen, setProjectFilesSheetOpen] = useState(false)

  // File upload state
  const [isUploading, setIsUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerFile, setViewerFile] = useState<any>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)

  // Transitions
  const [isSaving, startSaving] = useTransition()
  const [isInviting, startInviting] = useTransition()
  const [isAddingAddendum, startAddingAddendum] = useTransition()
  const [isAwarding, startAwarding] = useTransition()
  const [isLinkingFiles, startLinkingFiles] = useTransition()

  // Derived state
  const vendorCompanyIds = useMemo(
    () => new Set(projectVendors.map((vendor) => vendor.company_id).filter(Boolean)),
    [projectVendors]
  )

  const vendorScopeByCompanyId = useMemo(() => {
    const map = new Map<string, string>()
    for (const vendor of projectVendors) {
      if (!vendor.company_id || !vendor.scope) continue
      const previous = map.get(vendor.company_id)
      map.set(vendor.company_id, previous ? `${previous} ${vendor.scope}` : vendor.scope)
    }
    return map
  }, [projectVendors])

  const invitedCompanyIds = useMemo(
    () => new Set(inviteList.map((inv) => inv.company_id)),
    [inviteList]
  )

  const submissionByInviteId = useMemo(() => {
    const map = new Map<string, BidSubmission>()
    for (const sub of submissionList) {
      if (sub.is_current && sub.bid_invite_id) {
        map.set(sub.bid_invite_id, sub)
      }
    }
    return map
  }, [submissionList])

  const tradeOptions = useMemo(() => {
    const tradeMap = new Map<string, string>()
    const addTrade = (tradeValue?: string | null) => {
      const trimmed = tradeValue?.trim()
      const normalized = normalizeTrade(trimmed)
      if (!normalized) return
      if (!tradeMap.has(normalized) && trimmed) {
        tradeMap.set(normalized, trimmed)
      }
    }
    addTrade(current.trade)
    for (const company of companies) {
      addTrade(company.trade)
    }
    return Array.from(tradeMap.values()).sort((a, b) => a.localeCompare(b))
  }, [current.trade, companies])

  const availableTrades = useMemo(
    () => tradeOptions.map((label) => ({ value: normalizeTrade(label), label })),
    [tradeOptions],
  )

  const filteredCompanies = useMemo(() => {
    const searchLower = companySearch.toLowerCase().trim()
    return companies
      .filter((company) => {
        if (tradeFilter !== "all") {
          const companyMatches = matchesTradeFilter(company.trade, tradeFilter)
          const scopeMatches = matchesTradeFilter(vendorScopeByCompanyId.get(company.id), tradeFilter)
          if (!companyMatches && !scopeMatches) {
            return false
          }
        }
        if (searchLower && !company.name.toLowerCase().includes(searchLower)) {
          return false
        }
        return true
      })
      .sort((a, b) => {
        const aIsVendor = vendorCompanyIds.has(a.id)
        const bIsVendor = vendorCompanyIds.has(b.id)
        if (aIsVendor && !bIsVendor) return -1
        if (!aIsVendor && bIsVendor) return 1
        return a.name.localeCompare(b.name)
      })
  }, [companies, companySearch, tradeFilter, vendorCompanyIds, vendorScopeByCompanyId])

  const getCompanyContactInfo = useCallback(
    (companyId: string) => {
      const vendor = projectVendors.find((v) => v.company_id === companyId && v.contact)
      return vendor?.contact ?? null
    },
    [projectVendors]
  )

  const dueDate = current.due_at ? new Date(current.due_at) : null
  const isOverdue = Boolean(dueDate && isPast(dueDate) && !["awarded", "closed", "cancelled"].includes(current.status))
  const attachedFileIds = useMemo(
    () => new Set(packageAttachments.map((attachment) => attachment.id)),
    [packageAttachments]
  )

  const attachmentsTree = useMemo(
    () => buildAttachmentFolderTree(packageAttachments),
    [packageAttachments]
  )

  const projectFolderOptions = useMemo(() => {
    const fromFiles = projectFiles
      .map((file) => normalizeFolderPath(file.folder_path))
      .filter(Boolean)
    const merged = new Set<string>([...projectFolders.map((value) => normalizeFolderPath(value)), ...fromFiles])
    return Array.from(merged).sort((a, b) => a.localeCompare(b))
  }, [projectFiles, projectFolders])

  const filteredProjectFiles = useMemo(() => {
    const searchValue = projectFileSearch.trim().toLowerCase()
    return projectFiles
      .filter((file) => {
        const normalizedFolder = normalizeFolderPath(file.folder_path)
        if (projectFolderFilter !== "all") {
          if (normalizedFolder !== projectFolderFilter && !normalizedFolder.startsWith(`${projectFolderFilter}/`)) {
            return false
          }
        }

        if (!searchValue) return true
        const inName = file.file_name.toLowerCase().includes(searchValue)
        const inFolder = normalizedFolder.toLowerCase().includes(searchValue)
        const inTags = (file.tags ?? []).some((tag) => tag.toLowerCase().includes(searchValue))
        return inName || inFolder || inTags
      })
      .sort((a, b) => {
        const aFolder = normalizeFolderPath(a.folder_path)
        const bFolder = normalizeFolderPath(b.folder_path)
        if (aFolder !== bFolder) return aFolder.localeCompare(bFolder)
        return a.file_name.localeCompare(b.file_name)
      })
  }, [projectFiles, projectFileSearch, projectFolderFilter])

  // Attachments loading
  const loadPackageAttachments = useCallback(async () => {
    const links = await listAttachmentsAction("bid_package", bidPackage.id)
    setPackageAttachments(mapAttachments(links))
  }, [bidPackage.id])

  const loadAddendumAttachments = useCallback(async () => {
    const entries: Record<string, AttachedFile[]> = {}
    for (const addendum of addendumList) {
      const links = await listAttachmentsAction("bid_addendum", addendum.id)
      entries[addendum.id] = mapAttachments(links)
    }
    setAddendumAttachments(entries)
  }, [addendumList])

  useEffect(() => {
    loadPackageAttachments()
  }, [loadPackageAttachments])

  useEffect(() => {
    loadAddendumAttachments()
  }, [loadAddendumAttachments])

  const loadProjectFiles = useCallback(async () => {
    setIsLoadingProjectFiles(true)
    try {
      const pageSize = 200
      let offset = 0
      let hasMore = true
      let allFiles: FileWithUrls[] = []

      while (hasMore) {
        const page = await listFilesAction({
          project_id: projectId,
          include_archived: false,
          limit: pageSize,
          offset,
        })
        allFiles = [...allFiles, ...page]
        hasMore = page.length === pageSize
        offset += pageSize
      }

      const folders = await listFoldersAction(projectId)
      setProjectFiles(allFiles)
      setProjectFolders(folders)
    } catch {
      toast.error("Failed to load project files")
    } finally {
      setIsLoadingProjectFiles(false)
    }
  }, [projectId])

  useEffect(() => {
    if (!projectFilesSheetOpen) return
    loadProjectFiles()
  }, [projectFilesSheetOpen, loadProjectFiles])

  const loadSubmissionAttachments = useCallback(async (submissionId: string) => {
    setIsLoadingSubmissionAttachments(true)
    try {
      const links = await listAttachmentsAction("bid_submission", submissionId)
      const attachments = mapAttachments(links)
      setSubmissionAttachments((prev) => ({ ...prev, [submissionId]: attachments }))
      return attachments
    } catch {
      toast.error("Failed to load submission attachments")
      return []
    } finally {
      setIsLoadingSubmissionAttachments(false)
    }
  }, [])

  useEffect(() => {
    if (!submissionSheetOpen || !detailSubmission) return
    if (submissionAttachments[detailSubmission.id]) return
    loadSubmissionAttachments(detailSubmission.id)
  }, [submissionSheetOpen, detailSubmission, submissionAttachments, loadSubmissionAttachments])

  // File upload handlers
  const handleFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      setIsUploading(true)
      try {
        for (const file of files) {
          const formData = new FormData()
          formData.append("file", file)
          formData.append("projectId", projectId)
          formData.append("category", "plans")
          const uploaded = await uploadFileAction(formData)
          await attachFileAction(uploaded.id, "bid_package", bidPackage.id, projectId)
        }
        await loadPackageAttachments()
        toast.success(`${files.length} file${files.length > 1 ? "s" : ""} uploaded`)
      } catch {
        toast.error("Failed to upload files")
      } finally {
        setIsUploading(false)
      }
    },
    [projectId, bidPackage.id, loadPackageAttachments]
  )

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      if (fileInputRef.current) fileInputRef.current.value = ""
      if (files.length > 0) handleFiles(files)
    },
    [handleFiles]
  )

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current += 1
    if (e.dataTransfer.items?.length) setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current -= 1
    if (dragCounterRef.current === 0) setIsDragging(false)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
      dragCounterRef.current = 0
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) await handleFiles(files)
    },
    [handleFiles]
  )

  const handleFileDetach = useCallback(
    async (attachment: AttachedFile) => {
      try {
        await detachFileLinkAction(attachment.linkId)
        await loadPackageAttachments()
        toast.success(`Removed ${attachment.file_name}`)
      } catch {
        toast.error("Failed to remove file")
      }
    },
    [loadPackageAttachments]
  )

  const toggleProjectFileSelection = useCallback((fileId: string) => {
    setSelectedProjectFileIds((prev) => {
      const next = new Set(prev)
      if (next.has(fileId)) {
        next.delete(fileId)
      } else {
        next.add(fileId)
      }
      return next
    })
  }, [])

  const selectAllVisibleProjectFiles = useCallback(() => {
    setSelectedProjectFileIds((prev) => {
      const next = new Set(prev)
      for (const file of filteredProjectFiles) {
        if (!attachedFileIds.has(file.id)) {
          next.add(file.id)
        }
      }
      return next
    })
  }, [filteredProjectFiles, attachedFileIds])

  const clearProjectFileSelection = useCallback(() => {
    setSelectedProjectFileIds(new Set())
  }, [])

  const handleAttachSelectedProjectFiles = useCallback(() => {
    if (selectedProjectFileIds.size === 0) {
      toast.error("Select at least one file")
      return
    }

    const fileIds = Array.from(selectedProjectFileIds)
    startLinkingFiles(async () => {
      try {
        await Promise.all(
          fileIds.map((fileId) => attachFileAction(fileId, "bid_package", bidPackage.id, projectId))
        )
        await loadPackageAttachments()
        setProjectFilesSheetOpen(false)
        setSelectedProjectFileIds(new Set())
        setProjectFileSearch("")
        setProjectFolderFilter("all")
        toast.success(`Added ${fileIds.length} file${fileIds.length === 1 ? "" : "s"} from project files`)
      } catch {
        toast.error("Failed to attach selected files")
      }
    })
  }, [selectedProjectFileIds, bidPackage.id, projectId, loadPackageAttachments, startLinkingFiles])

  const handleFilePreview = useCallback((attachment: AttachedFile) => {
    setViewerFile({
      id: attachment.id,
      org_id: "",
      file_name: attachment.file_name,
      storage_path: "",
      visibility: "private",
      created_at: attachment.created_at,
      mime_type: attachment.mime_type,
      size_bytes: attachment.size_bytes,
      download_url: attachment.download_url,
      thumbnail_url: attachment.thumbnail_url,
    })
    setViewerOpen(true)
  }, [])

  const handleFileDownload = useCallback((attachment: AttachedFile) => {
    if (attachment.download_url) {
      const link = document.createElement("a")
      link.href = attachment.download_url
      link.download = attachment.file_name
      link.click()
    }
  }, [])

  const previewableFiles = packageAttachments
    .filter((a) => isPreviewable(a.mime_type))
    .map((a) => ({
      id: a.id,
      org_id: "",
      file_name: a.file_name,
      storage_path: "",
      visibility: "private",
      created_at: a.created_at,
      mime_type: a.mime_type,
      size_bytes: a.size_bytes,
      download_url: a.download_url,
      thumbnail_url: a.thumbnail_url,
    }))

  // Handlers
  const handleSave = () => {
    if (!title.trim()) {
      toast.error("Title is required")
      return
    }
    startSaving(async () => {
      try {
        const updated = await updateBidPackageAction(bidPackage.id, projectId, {
          title: title.trim(),
          trade: trade === NO_TRADE_VALUE ? null : trade,
          due_at: dueAt ? dueAt.toISOString() : null,
          status,
          scope: scope.trim() || null,
          instructions: instructions.trim() || null,
        })
        setCurrent(updated)
        setTitle(updated.title)
        setTrade(updated.trade?.trim() || NO_TRADE_VALUE)
        setDueAt(updated.due_at ? new Date(updated.due_at) : undefined)
        setStatus(updated.status)
        setScope(updated.scope ?? "")
        setInstructions(updated.instructions ?? "")
        setEditSheetOpen(false)
        toast.success("Bid package updated")
      } catch (error: any) {
        toast.error("Failed to update package", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const totalInviteCount = selectedCompanyIds.size + emailInvites.length

  const handleBulkInvite = () => {
    if (totalInviteCount === 0) {
      toast.error("Select at least one company or add an email to invite")
      return
    }
    startInviting(async () => {
      try {
        const companyInviteItems = Array.from(selectedCompanyIds).map((companyId) => {
          const contact = getCompanyContactInfo(companyId)
          const company = companies.find((c) => c.id === companyId)
          return {
            company_id: companyId,
            contact_id: contact?.id ?? null,
            invite_email: contact?.email || company?.email || null,
          }
        })

        const emailOnlyInviteItems = emailInvites.map((item) => ({
          company_id: null,
          contact_id: null,
          invite_email: item.email,
          company_name: item.companyName || null,
        }))

        const result = await bulkCreateBidInvitesAction(projectId, bidPackage.id, {
          bid_package_id: bidPackage.id,
          invites: [...companyInviteItems, ...emailOnlyInviteItems],
          send_emails: sendEmails,
        })

        setInviteList((prev) => [...result.created, ...prev])
        setSelectedCompanyIds(new Set())
        setCompanySearch("")
        setEmailInvites([])
        setNewEmailInput("")
        setNewCompanyNameInput("")
        setInviteDialogOpen(false)

        const successCount = result.created.length
        const failedCount = result.failed.length
        const emailCount = result.emailsSent
        const newCompanies = result.companiesCreated

        const parts: string[] = []
        if (sendEmails && emailCount > 0) {
          parts.push(`${emailCount} email${emailCount !== 1 ? "s" : ""} sent`)
        }
        if (newCompanies > 0) {
          parts.push(`${newCompanies} new compan${newCompanies !== 1 ? "ies" : "y"} added`)
        }

        if (failedCount > 0) {
          toast.warning(`Created ${successCount} invites, ${failedCount} failed`)
        } else {
          toast.success(`Created ${successCount} invite${successCount !== 1 ? "s" : ""}`, {
            description: parts.join(", ") || undefined,
          })
        }
      } catch (error: any) {
        toast.error("Failed to create invites", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const addEmailInvite = () => {
    const email = newEmailInput.trim().toLowerCase()
    if (!email) return

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error("Please enter a valid email address")
      return
    }

    if (emailInvites.some((inv) => inv.email === email)) {
      toast.error("This email has already been added")
      return
    }

    const existingCompany = companies.find((c) => c.email?.toLowerCase() === email)
    if (existingCompany) {
      toast.error(`A company with this email already exists: ${existingCompany.name}`)
      return
    }

    setEmailInvites((prev) => [...prev, { email, companyName: newCompanyNameInput.trim() }])
    setNewEmailInput("")
    setNewCompanyNameInput("")
  }

  const removeEmailInvite = (email: string) => {
    setEmailInvites((prev) => prev.filter((inv) => inv.email !== email))
  }

  const toggleCompanySelection = (companyId: string) => {
    setSelectedCompanyIds((prev) => {
      const next = new Set(prev)
      if (next.has(companyId)) {
        next.delete(companyId)
      } else {
        next.add(companyId)
      }
      return next
    })
  }

  const selectAllFiltered = () => {
    setSelectedCompanyIds((prev) => {
      const next = new Set(prev)
      for (const company of filteredCompanies) {
        if (!invitedCompanyIds.has(company.id)) {
          next.add(company.id)
        }
      }
      return next
    })
  }

  const clearSelection = () => {
    setSelectedCompanyIds(new Set())
    setEmailInvites([])
  }

  const handleGenerateLink = async (invite: BidInvite) => {
    try {
      const result = await generateBidInviteLinkAction(projectId, bidPackage.id, invite.id)
      await navigator.clipboard.writeText(result.url)
      const refreshed = await listBidInvitesAction(bidPackage.id)
      setInviteList(refreshed)
      toast.success("Bid link copied to clipboard")
    } catch (error: any) {
      toast.error("Failed to generate link", { description: error?.message ?? "Please try again." })
    }
  }

  const handlePauseInviteAccess = async (invite: BidInvite) => {
    try {
      await pauseBidInviteAccessAction(projectId, bidPackage.id, invite.id)
      const refreshed = await listBidInvitesAction(bidPackage.id)
      setInviteList(refreshed)
      toast.success("Invite access paused")
    } catch (error: any) {
      toast.error("Failed to pause invite access", { description: error?.message ?? "Please try again." })
    }
  }

  const handleResumeInviteAccess = async (invite: BidInvite) => {
    try {
      await resumeBidInviteAccessAction(projectId, bidPackage.id, invite.id)
      const refreshed = await listBidInvitesAction(bidPackage.id)
      setInviteList(refreshed)
      toast.success("Invite access resumed")
    } catch (error: any) {
      toast.error("Failed to resume invite access", { description: error?.message ?? "Please try again." })
    }
  }

  const handleRevokeInviteAccess = async (invite: BidInvite) => {
    try {
      await revokeBidInviteAccessAction(projectId, bidPackage.id, invite.id)
      const refreshed = await listBidInvitesAction(bidPackage.id)
      setInviteList(refreshed)
      toast.success("Invite access revoked")
    } catch (error: any) {
      toast.error("Failed to revoke invite access", { description: error?.message ?? "Please try again." })
    }
  }

  const handleSetInviteRequireAccount = async (invite: BidInvite, requireAccount: boolean) => {
    try {
      await setBidInviteRequireAccountAction(projectId, bidPackage.id, invite.id, requireAccount)
      const refreshed = await listBidInvitesAction(bidPackage.id)
      setInviteList(refreshed)
      toast.success(requireAccount ? "Account required enabled" : "Link-only access enabled")
    } catch (error: any) {
      toast.error("Failed to update access mode", { description: error?.message ?? "Please try again." })
    }
  }

  const handlePauseInviteAccounts = async (invite: BidInvite) => {
    try {
      await pauseBidInviteAccountGrantsAction(projectId, bidPackage.id, invite.id)
      const refreshed = await listBidInvitesAction(bidPackage.id)
      setInviteList(refreshed)
      toast.success("Linked accounts paused")
    } catch (error: any) {
      toast.error("Failed to pause linked accounts", { description: error?.message ?? "Please try again." })
    }
  }

  const handleResumeInviteAccounts = async (invite: BidInvite) => {
    try {
      await resumeBidInviteAccountGrantsAction(projectId, bidPackage.id, invite.id)
      const refreshed = await listBidInvitesAction(bidPackage.id)
      setInviteList(refreshed)
      toast.success("Linked accounts resumed")
    } catch (error: any) {
      toast.error("Failed to resume linked accounts", { description: error?.message ?? "Please try again." })
    }
  }

  const handleRevokeInviteAccounts = async (invite: BidInvite) => {
    try {
      await revokeBidInviteAccountGrantsAction(projectId, bidPackage.id, invite.id)
      const refreshed = await listBidInvitesAction(bidPackage.id)
      setInviteList(refreshed)
      toast.success("Linked accounts revoked")
    } catch (error: any) {
      toast.error("Failed to revoke linked accounts", { description: error?.message ?? "Please try again." })
    }
  }

  const handleAddendum = () => {
    startAddingAddendum(async () => {
      try {
        const addendum = await createBidAddendumAction(projectId, {
          bid_package_id: bidPackage.id,
          title: addendumTitle.trim() || null,
          message: addendumMessage.trim() || null,
        })
        setAddendumList((prev) => [...prev, addendum])
        setAddendumTitle("")
        setAddendumMessage("")
        setAddendumDialogOpen(false)
        toast.success("Addendum issued")
      } catch (error: any) {
        toast.error("Failed to create addendum", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const openAwardDialog = (submission: BidSubmission) => {
    if (current.status === "awarded") {
      toast.error("This package is already awarded")
      return
    }
    if (!submission.is_current) {
      toast.error("Only the current submission can be awarded")
      return
    }
    if (!submission.total_cents && submission.total_cents !== 0) {
      toast.error("Submission total is required to award")
      return
    }
    setSelectedSubmission(submission)
    setAwardDialogOpen(true)
  }

  const openSubmissionSheet = useCallback((submission: BidSubmission) => {
    setDetailSubmission(submission)
    setSubmissionSheetOpen(true)
  }, [])

  const handleAward = () => {
    if (!selectedSubmission) return
    const awardedSubmissionId = selectedSubmission.id
    startAwarding(async () => {
      try {
        await awardBidSubmissionAction(projectId, bidPackage.id, awardedSubmissionId)
        setCurrent((prev) => ({ ...prev, status: "awarded" }))
        setStatus("awarded")
        setSubmissionList((prev) =>
          prev.map((submission) => ({
            ...submission,
            is_awarded: submission.id === awardedSubmissionId,
          })),
        )
        setDetailSubmission((prev) =>
          prev
            ? {
                ...prev,
                is_awarded: prev.id === awardedSubmissionId,
              }
            : prev,
        )
        setAwardDialogOpen(false)
        setSelectedSubmission(null)
        toast.success("Bid awarded and commitment created")
      } catch (error: any) {
        toast.error("Failed to award bid", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const handleAddendumAttach = useCallback(
    async (files: File[], addendumId: string) => {
      for (const file of files) {
        const formData = new FormData()
        formData.append("file", file)
        formData.append("projectId", projectId)
        formData.append("category", "plans")
        const uploaded = await uploadFileAction(formData)
        await attachFileAction(uploaded.id, "bid_addendum", addendumId, projectId)
      }
      await loadAddendumAttachments()
    },
    [projectId, loadAddendumAttachments]
  )

  const handleAddendumDetach = useCallback(
    async (linkId: string) => {
      await detachFileLinkAction(linkId)
      await loadAddendumAttachments()
    },
    [loadAddendumAttachments]
  )

  const detailAttachments = detailSubmission
    ? submissionAttachments[detailSubmission.id] ?? []
    : []

  const formatDateValue = (value?: string | null, pattern = "MMM d, yyyy") => {
    if (!value) return "—"
    return format(new Date(value), pattern)
  }

  const detailCompanyName = detailSubmission?.invite?.company?.name ?? "Unknown company"
  const detailContactName =
    detailSubmission?.submitted_by_name ??
    detailSubmission?.invite?.contact?.full_name ??
    "—"
  const detailContactEmail =
    detailSubmission?.submitted_by_email ??
    detailSubmission?.invite?.contact?.email ??
    detailSubmission?.invite?.invite_email ??
    "—"
  const detailBenchmark = detailSubmission?.benchmark
  const detailBenchmarkSummary = getPriceIntelligenceSummary(detailSubmission)
  const detailBenchmarkConfidence = getBenchmarkConfidence(detailBenchmark)
  const showDetailNotes = Boolean(
    detailSubmission?.exclusions || detailSubmission?.clarifications || detailSubmission?.notes
  )
  const marketSummary = useMemo(() => {
    const counts: Record<PriceIntelligenceSignal, number> = {
      pending: 0,
      insufficient_data: 0,
      in_range: 0,
      below_range: 0,
      above_range: 0,
    }
    const deviations: number[] = []

    for (const submission of submissionByInviteId.values()) {
      const intelligence = getPriceIntelligenceSummary(submission)
      counts[intelligence.signal] += 1
      const deviation = submission.benchmark?.deviation_pct
      if (deviation != null && Number.isFinite(deviation)) {
        deviations.push(Math.abs(deviation))
      }
    }

    return {
      counts,
      submissionCount: submissionByInviteId.size,
      medianSpreadPct: computeMedian(deviations),
    }
  }, [submissionByInviteId])

  const dueRelativeLabel = dueDate ? `Due ${formatDistanceToNow(dueDate, { addSuffix: true })}` : "No due date"
  const hasDocumentTreeContent = attachmentsTree.children.length > 0 || attachmentsTree.files.length > 0

  const bidStats = useMemo(() => {
    const amounts = Array.from(submissionByInviteId.values())
      .filter((s) => s.total_cents != null)
      .map((s) => s.total_cents!)
    return {
      count: amounts.length,
      lowest: amounts.length > 0 ? Math.min(...amounts) : null,
      highest: amounts.length > 0 ? Math.max(...amounts) : null,
    }
  }, [submissionByInviteId])

  const chartData = useMemo(() => {
    const bids: Array<{
      amount: number
      company: string
      signal: PriceIntelligenceSignal
      isAwarded: boolean
    }> = []
    let refBenchmark: BidSubmission["benchmark"] | null = null
    for (const submission of submissionByInviteId.values()) {
      if (submission.total_cents != null) {
        bids.push({
          amount: submission.total_cents,
          company: submission.invite?.company?.name ?? "Unknown",
          signal: getPriceIntelligenceSummary(submission).signal,
          isAwarded: submission.is_awarded === true,
        })
      }
      if (
        !refBenchmark &&
        submission.benchmark?.has_benchmark &&
        submission.benchmark.signal !== "insufficient_data"
      ) {
        refBenchmark = submission.benchmark
      }
    }
    bids.sort((a, b) => a.amount - b.amount)
    return { bids, benchmark: refBenchmark }
  }, [submissionByInviteId])

  const statusConfig: Record<string, { dot: string; label: string }> = {
    draft: { dot: "bg-muted-foreground", label: "Draft" },
    sent: { dot: "bg-blue-500", label: "Sent" },
    open: { dot: "bg-emerald-500", label: "Open" },
    closed: { dot: "bg-muted-foreground", label: "Closed" },
    awarded: { dot: "bg-amber-500", label: "Awarded" },
    cancelled: { dot: "bg-rose-500", label: "Cancelled" },
  }
  const currentStatusConfig = statusConfig[current.status] ?? statusConfig.draft

  const signalDotColor = (signal: PriceIntelligenceSignal) => {
    switch (signal) {
      case "in_range": return "bg-emerald-500"
      case "below_range": return "bg-amber-500"
      case "above_range": return "bg-rose-500"
      default: return "bg-muted-foreground/60"
    }
  }

  const renderPriceRangeChart = () => {
    if (chartData.bids.length === 0) return null
    const allValues = [
      ...chartData.bids.map((b) => b.amount),
      ...(chartData.benchmark
        ? ([chartData.benchmark.p25_cents, chartData.benchmark.p75_cents, chartData.benchmark.median_cents].filter(
            (v) => v != null
          ) as number[])
        : []),
    ]
    const dataMin = Math.min(...allValues)
    const dataMax = Math.max(...allValues)
    const padding = (dataMax - dataMin) * 0.18 || dataMin * 0.1 || 1000
    const scaleMin = dataMin - padding
    const scaleMax = dataMax + padding
    const range = scaleMax - scaleMin || 1
    const toPercent = (value: number) => Math.max(2, Math.min(98, ((value - scaleMin) / range) * 100))

    return (
      <div className="space-y-1.5">
        <div className="relative h-14 rounded-lg bg-muted/30 border">
          {chartData.benchmark?.p25_cents != null && chartData.benchmark?.p75_cents != null && (
            <div
              className="absolute top-1.5 bottom-1.5 rounded bg-emerald-500/[0.08] border border-emerald-500/20"
              style={{
                left: `${toPercent(chartData.benchmark.p25_cents)}%`,
                width: `${toPercent(chartData.benchmark.p75_cents) - toPercent(chartData.benchmark.p25_cents)}%`,
              }}
            />
          )}
          {chartData.benchmark?.median_cents != null && (
            <div
              className="absolute top-1 bottom-1 w-px bg-emerald-500/40"
              style={{ left: `${toPercent(chartData.benchmark.median_cents)}%` }}
            />
          )}
          {chartData.bids.map((bid, i) => (
            <Tooltip key={i}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 group/dot z-10"
                  style={{ left: `${toPercent(bid.amount)}%` }}
                >
                  <div
                    className={cn(
                      "h-4 w-4 rounded-full border-2 border-background shadow-sm transition-transform group-hover/dot:scale-[1.35]",
                      signalDotColor(bid.signal),
                      bid.isAwarded && "ring-2 ring-amber-400 ring-offset-1 ring-offset-background"
                    )}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-center">
                <p className="font-medium text-xs">{bid.company}</p>
                <p className="text-[11px] tabular-nums">{formatCurrency(bid.amount)}</p>
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground tabular-nums px-0.5">
          <span>{formatCurrency(Math.round(scaleMin / 100) * 100)}</span>
          {chartData.benchmark?.median_cents != null && (
            <span className="text-emerald-600 font-medium">
              Median {formatCurrency(chartData.benchmark.median_cents)}
            </span>
          )}
          <span>{formatCurrency(Math.round(scaleMax / 100) * 100)}</span>
        </div>
      </div>
    )
  }

  const renderSingleBidPosition = (submission: BidSubmission) => {
    const benchmark = submission.benchmark
    if (!benchmark?.has_benchmark || benchmark.signal === "insufficient_data" || submission.total_cents == null) {
      return null
    }
    const allValues = [
      submission.total_cents,
      benchmark.p25_cents,
      benchmark.p75_cents,
      benchmark.median_cents,
    ].filter((v) => v != null) as number[]
    const dataMin = Math.min(...allValues)
    const dataMax = Math.max(...allValues)
    const padding = (dataMax - dataMin) * 0.2 || dataMin * 0.1 || 1000
    const scaleMin = dataMin - padding
    const scaleMax = dataMax + padding
    const range = scaleMax - scaleMin || 1
    const toPercent = (v: number) => Math.max(2, Math.min(98, ((v - scaleMin) / range) * 100))
    const intel = getPriceIntelligenceSummary(submission)

    return (
      <div className="space-y-1">
        <div className="relative h-3 rounded-full bg-muted/40">
          {benchmark.p25_cents != null && benchmark.p75_cents != null && (
            <div
              className="absolute top-0 bottom-0 rounded-full bg-emerald-500/15"
              style={{
                left: `${toPercent(benchmark.p25_cents)}%`,
                width: `${toPercent(benchmark.p75_cents) - toPercent(benchmark.p25_cents)}%`,
              }}
            />
          )}
          {benchmark.median_cents != null && (
            <div
              className="absolute top-0 bottom-0 w-px bg-emerald-500/40"
              style={{ left: `${toPercent(benchmark.median_cents)}%` }}
            />
          )}
          <div
            className={cn(
              "absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3.5 w-3.5 rounded-full border-2 border-background shadow-sm",
              signalDotColor(intel.signal)
            )}
            style={{ left: `${toPercent(submission.total_cents)}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
          <span>{formatCurrency(benchmark.p25_cents)}</span>
          <span>{formatCurrency(benchmark.p75_cents)}</span>
        </div>
      </div>
    )
  }

  const renderDocumentAttachmentRow = (attachment: BidPackageAttachment, nested = false) => (
    <div
      key={attachment.linkId}
      className={cn(
        "group flex items-center gap-2 rounded-md p-2 hover:bg-muted/50 transition-colors",
        nested && "ml-2"
      )}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted text-sm">
        {getMimeIcon(attachment.mime_type)}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate leading-tight">{attachment.file_name}</p>
        <p className="text-[11px] text-muted-foreground">{formatFileSize(attachment.size_bytes)}</p>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {isPreviewable(attachment.mime_type) && (
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleFilePreview(attachment)}>
            <Eye className="h-3 w-3" />
          </Button>
        )}
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleFileDownload(attachment)}>
          <Download className="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={() => handleFileDetach(attachment)}>
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )

  const renderFolderNode = (node: AttachmentFolderNode): React.ReactNode => (
    <details key={node.path} open className="rounded-md border bg-background/60">
      <summary className="cursor-pointer list-none px-3 py-2.5 hover:bg-muted/40">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="truncate text-sm font-medium">{node.name}</p>
          </div>
          <Badge variant="secondary" className="text-[10px]">
            {countNodeFiles(node)}
          </Badge>
        </div>
      </summary>
      <div className="border-t px-2 py-1">
        <div className="space-y-1">
          {node.children.map((child) => renderFolderNode(child))}
          {node.files.map((attachment) => renderDocumentAttachmentRow(attachment, true))}
        </div>
      </div>
    </details>
  )

  return (
    <TooltipProvider>
      <div className="flex min-h-0 flex-1 flex-col gap-5">
        {/* Edit Sheet */}
        <Sheet open={editSheetOpen} onOpenChange={setEditSheetOpen}>
          <SheetContent
            side="right"
            mobileFullscreen
            className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
            style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
          >
            <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
              <SheetTitle>Edit bid package</SheetTitle>
              <SheetDescription className="text-sm text-muted-foreground">
                Update the details for this bid package.
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="title">Title</Label>
                  <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="trade">Trade</Label>
                  <Select value={trade} onValueChange={setTrade}>
                    <SelectTrigger id="trade" className="w-full">
                      <SelectValue placeholder="Select trade" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_TRADE_VALUE}>No trade</SelectItem>
                      {tradeOptions.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="due">Due date</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        id="due"
                        variant="outline"
                        className={cn(
                          "w-full justify-start text-left font-normal",
                          !dueAt && "text-muted-foreground"
                        )}
                      >
                        <CalendarDays className="mr-2 h-4 w-4" />
                        {dueAt ? format(dueAt, "LLL dd, y") : "Pick a date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={dueAt}
                        onSelect={setDueAt}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="status">Status</Label>
                  <Select value={status} onValueChange={(value) => setStatus(value as BidPackageStatus)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {statusOptions.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option[0].toUpperCase() + option.slice(1)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="scope">Scope of work</Label>
                <Textarea
                  id="scope"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  placeholder="Describe the scope of work..."
                  rows={4}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="instructions">Bid instructions</Label>
                <Textarea
                  id="instructions"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="Instructions for bidders..."
                  rows={4}
                />
              </div>
            </div>
            <SheetFooter className="border-t bg-background/80 px-6 py-4">
              <div className="flex flex-col gap-2 sm:flex-row">
                <SheetClose asChild>
                  <Button variant="outline" className="w-full sm:flex-1">
                    Cancel
                  </Button>
                </SheetClose>
                <Button onClick={handleSave} disabled={isSaving} className="w-full sm:flex-1">
                  {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save changes
                </Button>
              </div>
            </SheetFooter>
          </SheetContent>
        </Sheet>

        {/* Submission Detail Sheet */}
        <Sheet
          open={submissionSheetOpen}
          onOpenChange={(open) => {
            setSubmissionSheetOpen(open)
            if (!open) setDetailSubmission(null)
          }}
        >
          <SheetContent
            side="right"
            mobileFullscreen
            className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
            style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
          >
            {detailSubmission ? (
              <>
                <SheetHeader className="px-6 pt-6 pb-4 border-b">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className={cn(
                        "flex h-9 w-9 items-center justify-center rounded-lg",
                        detailSubmission.is_awarded ? "bg-amber-500/15" : "bg-primary/10"
                      )}>
                        {detailSubmission.is_awarded
                          ? <Trophy className="h-4.5 w-4.5 text-amber-600" />
                          : <FileText className="h-4.5 w-4.5 text-primary" />}
                      </div>
                      <div>
                        <SheetTitle className="text-base">{detailCompanyName}</SheetTitle>
                        <SheetDescription className="text-left text-xs">
                          v{detailSubmission.version} · {formatDateValue(detailSubmission.submitted_at, "MMM d, yyyy")}
                        </SheetDescription>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge
                        variant="outline"
                        className={cn(
                          "capitalize text-xs",
                          detailSubmission.status === "submitted" && "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
                          detailSubmission.status === "revised" && "bg-blue-500/15 text-blue-600 border-blue-500/30"
                        )}
                      >
                        {detailSubmission.status}
                      </Badge>
                      {detailSubmission.is_awarded && (
                        <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 text-xs">Awarded</Badge>
                      )}
                    </div>
                  </div>
                </SheetHeader>

                <div className="flex-1 overflow-y-auto">
                  {/* Amount hero */}
                  <div className="px-6 py-5 border-b bg-muted/20">
                    <p className="text-xs text-muted-foreground mb-1">Bid Amount</p>
                    <p className="text-3xl font-bold tabular-nums tracking-tight">
                      {formatCurrency(detailSubmission.total_cents)}
                    </p>
                    <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                      <span>Valid until {formatDateValue(detailSubmission.valid_until)}</span>
                      {detailSubmission.lead_time_days && (
                        <span>{detailSubmission.lead_time_days}d lead time</span>
                      )}
                      {detailSubmission.duration_days && (
                        <span>{detailSubmission.duration_days}d duration</span>
                      )}
                    </div>
                  </div>

                  <div className="px-6 py-5 space-y-5">
                    {/* Price Intelligence - Premium */}
                    <div className="rounded-lg border border-primary/15 bg-gradient-to-b from-primary/[0.03] to-transparent p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Sparkles className="h-3.5 w-3.5 text-primary" />
                          <span className="text-xs font-semibold">Arc Intelligence</span>
                        </div>
                        <Badge variant="outline" className={cn("text-[10px] font-medium", detailBenchmarkConfidence.badgeClass)}>
                          {detailBenchmarkConfidence.label}
                        </Badge>
                      </div>

                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={cn("text-xs font-medium", detailBenchmarkSummary.badgeClass)}>
                          {detailBenchmarkSummary.label}
                        </Badge>
                        {detailBenchmark?.deviation_pct != null && (
                          <span className={cn("text-xs font-medium tabular-nums", detailBenchmarkSummary.textClass)}>
                            {formatDeviationPercent(detailBenchmark.deviation_pct)} vs median
                          </span>
                        )}
                      </div>

                      {renderSingleBidPosition(detailSubmission)}

                      {detailBenchmark?.has_benchmark && detailBenchmark.signal !== "insufficient_data" ? (
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="rounded-md border bg-background/60 px-2 py-1.5">
                            <p className="text-[10px] text-muted-foreground">Range</p>
                            <p className="text-xs font-semibold tabular-nums">
                              {formatCurrency(detailBenchmark.p25_cents)} – {formatCurrency(detailBenchmark.p75_cents)}
                            </p>
                          </div>
                          <div className="rounded-md border bg-background/60 px-2 py-1.5">
                            <p className="text-[10px] text-muted-foreground">Comparables</p>
                            <p className="text-xs font-semibold">{detailBenchmark.sample_size} bids · {detailBenchmark.org_count} orgs</p>
                          </div>
                          <div className="rounded-md border bg-background/60 px-2 py-1.5">
                            <p className="text-[10px] text-muted-foreground">Match</p>
                            <p className="text-xs font-semibold">{getMatchLevelLabel(detailBenchmark.match_level)}</p>
                          </div>
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          {detailBenchmarkSummary.message}
                        </p>
                      )}

                      <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground pt-1 border-t">
                        <Shield className="h-3 w-3 shrink-0" />
                        Aggregated signals only. No source bid details exposed.
                      </p>
                    </div>

                    {/* Contact */}
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Contact</p>
                      <div className="text-sm">
                        <p className="font-medium">{detailContactName}</p>
                        <p className="text-muted-foreground">{detailContactEmail}</p>
                      </div>
                    </div>

                    {/* Notes & Clarifications */}
                    {showDetailNotes && (
                      <div className="space-y-3">
                        <p className="text-xs font-medium text-muted-foreground">Notes & Clarifications</p>
                        <div className="space-y-2.5 text-sm">
                          {detailSubmission.exclusions && (
                            <div className="rounded-md border bg-rose-500/[0.03] p-3">
                              <p className="text-[10px] font-semibold uppercase text-rose-600 mb-1">Exclusions</p>
                              <p className="whitespace-pre-wrap text-foreground/90">{detailSubmission.exclusions}</p>
                            </div>
                          )}
                          {detailSubmission.clarifications && (
                            <div className="rounded-md border bg-amber-500/[0.03] p-3">
                              <p className="text-[10px] font-semibold uppercase text-amber-600 mb-1">Clarifications</p>
                              <p className="whitespace-pre-wrap text-foreground/90">{detailSubmission.clarifications}</p>
                            </div>
                          )}
                          {detailSubmission.notes && (
                            <div className="rounded-md border bg-muted/30 p-3">
                              <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Notes</p>
                              <p className="whitespace-pre-wrap text-foreground/90">{detailSubmission.notes}</p>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Attachments */}
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Attachments</p>
                      {isLoadingSubmissionAttachments && detailAttachments.length === 0 ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Loading...
                        </div>
                      ) : (
                        <EntityAttachments
                          entityType="bid_submission"
                          entityId={detailSubmission.id}
                          projectId={projectId}
                          attachments={detailAttachments}
                          onAttach={async () => {}}
                          onDetach={async () => {}}
                          readOnly
                        />
                      )}
                    </div>
                  </div>
                </div>

                {/* Sheet footer with award action */}
                {!detailSubmission.is_awarded &&
                  current.status !== "awarded" &&
                  detailSubmission.is_current &&
                  detailSubmission.total_cents != null && (
                    <div className="border-t px-6 py-3 bg-background/80">
                      <Button
                        className="w-full"
                        onClick={() => openAwardDialog(detailSubmission)}
                      >
                        <Trophy className="mr-2 h-4 w-4" />
                        Award this bid
                      </Button>
                    </div>
                  )}
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Select a submission to view details.
              </div>
            )}
          </SheetContent>
        </Sheet>

        <Sheet
          open={projectFilesSheetOpen}
          onOpenChange={(open) => {
            setProjectFilesSheetOpen(open)
            if (!open) {
              setSelectedProjectFileIds(new Set())
              setProjectFileSearch("")
              setProjectFolderFilter("all")
            }
          }}
        >
          <SheetContent
            side="right"
            mobileFullscreen
            className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
            style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
          >
            <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
              <SheetTitle>Add from project files</SheetTitle>
              <SheetDescription className="text-sm text-muted-foreground">
                Link existing project files into this bid package without re-uploading.
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              <div className="flex gap-2">
                <Select value={projectFolderFilter} onValueChange={setProjectFolderFilter}>
                  <SelectTrigger className="w-[220px]">
                    <SelectValue placeholder="All folders" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All folders</SelectItem>
                    {projectFolderOptions.map((folder) => (
                      <SelectItem key={folder} value={folder}>
                        {folder}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={projectFileSearch}
                    onChange={(e) => setProjectFileSearch(e.target.value)}
                    placeholder="Search files, folders, or tags..."
                    className="pl-9"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {selectedProjectFileIds.size} selected
                </span>
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={selectAllVisibleProjectFiles} className="h-7 text-xs">
                    Select visible
                  </Button>
                  {selectedProjectFileIds.size > 0 && (
                    <Button type="button" variant="ghost" size="sm" onClick={clearProjectFileSelection} className="h-7 text-xs">
                      Clear
                    </Button>
                  )}
                </div>
              </div>

              <ScrollArea className="h-[460px] rounded-md border">
                <div className="p-2">
                  {isLoadingProjectFiles ? (
                    <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Loading project files...
                    </div>
                  ) : filteredProjectFiles.length === 0 ? (
                    <p className="py-10 text-center text-sm text-muted-foreground">
                      No files found for this filter.
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {filteredProjectFiles.map((file) => {
                        const normalizedFolder = normalizeFolderPath(file.folder_path) || "Unsorted"
                        const isAlreadyAttached = attachedFileIds.has(file.id)
                        const isSelected = selectedProjectFileIds.has(file.id)

                        return (
                          <label
                            key={file.id}
                            className={cn(
                              "flex items-center gap-3 rounded-md px-3 py-2 cursor-pointer transition-colors",
                              isAlreadyAttached
                                ? "opacity-50 cursor-not-allowed bg-muted/50"
                                : isSelected
                                  ? "bg-accent"
                                  : "hover:bg-muted/50"
                            )}
                          >
                            <Checkbox
                              checked={isSelected}
                              disabled={isAlreadyAttached}
                              onCheckedChange={() => {
                                if (!isAlreadyAttached) toggleProjectFileSelection(file.id)
                              }}
                            />
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted text-sm">
                              {getMimeIcon(file.mime_type)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="truncate text-sm font-medium">{file.file_name}</p>
                                {isAlreadyAttached && (
                                  <Badge variant="outline" className="text-[10px] px-1 py-0 bg-blue-500/10 text-blue-600">
                                    Linked
                                  </Badge>
                                )}
                              </div>
                              <p className="truncate text-xs text-muted-foreground">
                                {normalizedFolder}
                              </p>
                            </div>
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
            <SheetFooter className="border-t bg-background/80 px-6 py-4">
              <div className="flex flex-col gap-2 sm:flex-row">
                <SheetClose asChild>
                  <Button variant="outline" className="w-full sm:flex-1">
                    Cancel
                  </Button>
                </SheetClose>
                <Button onClick={handleAttachSelectedProjectFiles} disabled={isLinkingFiles || selectedProjectFileIds.size === 0} className="w-full sm:flex-1">
                  {isLinkingFiles && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {selectedProjectFileIds.size === 0 ? "Select files" : `Add ${selectedProjectFileIds.size} file${selectedProjectFileIds.size === 1 ? "" : "s"}`}
                </Button>
              </div>
            </SheetFooter>
          </SheetContent>
        </Sheet>

        {/* === HEADER === */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className={cn("h-2.5 w-2.5 rounded-full shrink-0", currentStatusConfig.dot)} />
              <h2 className="text-2xl font-semibold tracking-tight">{current.title}</h2>
              <Badge variant="outline" className="text-[11px] capitalize">{currentStatusConfig.label}</Badge>
              {current.status === "awarded" && (
                <Badge variant="outline" className="border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300 text-[11px]">
                  <Trophy className="mr-1 h-3 w-3" />Awarded
                </Badge>
              )}
              {isOverdue && current.status !== "awarded" && (
                <Badge variant="outline" className="border-rose-500/30 bg-rose-500/10 text-rose-600 text-[11px]">Overdue</Badge>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5" />
                {current.trade || "No trade"}
              </span>
              <span className="text-border">|</span>
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="h-3.5 w-3.5" />
                {dueDate ? format(dueDate, "EEE, MMM d, yyyy") : "No due date"}
              </span>
              <span className="text-border">|</span>
              <span className={cn(isOverdue && "text-rose-600 font-medium")}>{dueRelativeLabel}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" className="h-8" onClick={() => setEditSheetOpen(true)}>
              <Edit className="mr-1.5 h-3.5 w-3.5" />Edit
            </Button>
            <Button variant="outline" size="sm" className="h-8" onClick={() => setAddendumDialogOpen(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />Addendum
            </Button>
          </div>
        </div>

        {/* === STATS STRIP === */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border bg-card px-4 py-3">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Users className="h-3.5 w-3.5" />
              <p className="text-xs font-medium">Invited</p>
            </div>
            <p className="text-2xl font-bold tabular-nums">{inviteList.length}</p>
          </div>
          <div className="rounded-lg border bg-card px-4 py-3">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <FileText className="h-3.5 w-3.5" />
              <p className="text-xs font-medium">Submitted</p>
            </div>
            <p className="text-2xl font-bold tabular-nums">{bidStats.count}</p>
          </div>
          <div className="rounded-lg border bg-card px-4 py-3">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <TrendingDown className="h-3.5 w-3.5" />
              <p className="text-xs font-medium">Lowest</p>
            </div>
            <p className="text-2xl font-bold tabular-nums">{bidStats.lowest != null ? formatCurrency(bidStats.lowest) : "—"}</p>
          </div>
          <div className="rounded-lg border bg-card px-4 py-3">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <TrendingUp className="h-3.5 w-3.5" />
              <p className="text-xs font-medium">Highest</p>
            </div>
            <p className="text-2xl font-bold tabular-nums">{bidStats.highest != null ? formatCurrency(bidStats.highest) : "—"}</p>
          </div>
        </div>

        {/* === SCOPE & INSTRUCTIONS (collapsible) === */}
        {(current.scope || current.instructions) && (
          <details className="group rounded-lg border bg-card">
            <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/30 transition-colors [&::-webkit-details-marker]:hidden list-none">
              <span>Scope & Instructions</span>
              <svg className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </summary>
            <div className="grid gap-3 border-t p-4 md:grid-cols-2">
              {current.scope && (
                <div className="rounded-md border bg-muted/20 p-3">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Scope of Work</p>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{current.scope}</p>
                </div>
              )}
              {current.instructions && (
                <div className="rounded-md border bg-muted/20 p-3">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Bid Instructions</p>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{current.instructions}</p>
                </div>
              )}
            </div>
          </details>
        )}

        {/* === ADDENDA (compact timeline) === */}
        {addendumList.length > 0 && (
          <details className="group rounded-lg border bg-card" open>
            <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/30 transition-colors [&::-webkit-details-marker]:hidden list-none">
              <span>{addendumList.length} Addend{addendumList.length === 1 ? "um" : "a"}</span>
              <svg className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </summary>
            <div className="border-t divide-y">
              {addendumList.map((addendum) => (
                <div key={addendum.id} className="flex gap-3 px-4 py-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-500/10 mt-0.5">
                    <span className="text-xs font-bold text-amber-600">{addendum.number}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium">{addendum.title || `Addendum ${addendum.number}`}</p>
                      <span className="text-xs text-muted-foreground">
                        {addendum.issued_at && format(new Date(addendum.issued_at), "MMM d, yyyy")}
                      </span>
                    </div>
                    {addendum.message && (
                      <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">{addendum.message}</p>
                    )}
                    {(addendumAttachments[addendum.id]?.length > 0) && (
                      <div className="mt-2">
                        <EntityAttachments
                          entityType="bid_addendum"
                          entityId={addendum.id}
                          projectId={projectId}
                          attachments={addendumAttachments[addendum.id] ?? []}
                          onAttach={(files) => handleAddendumAttach(files, addendum.id)}
                          onDetach={handleAddendumDetach}
                          compact
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}

        {/* === MARKET INTELLIGENCE (premium) === */}
        {chartData.bids.length > 0 && (
          <div className="rounded-lg border border-primary/15 bg-gradient-to-b from-primary/[0.03] to-transparent p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold leading-none">Arc Intelligence</h3>
                  <p className="text-[11px] text-muted-foreground mt-0.5">Private market benchmark</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {marketSummary.counts.in_range > 0 && (
                  <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[10px]">
                    {marketSummary.counts.in_range} in range
                  </Badge>
                )}
                {marketSummary.counts.below_range > 0 && (
                  <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 text-[10px]">
                    {marketSummary.counts.below_range} below
                  </Badge>
                )}
                {marketSummary.counts.above_range > 0 && (
                  <Badge variant="outline" className="border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300 text-[10px]">
                    {marketSummary.counts.above_range} above
                  </Badge>
                )}
              </div>
            </div>

            {renderPriceRangeChart()}

            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-4 pt-1">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Submissions</p>
                <p className="font-semibold tabular-nums">{marketSummary.submissionCount}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Median Spread</p>
                <p className="font-semibold tabular-nums">
                  {marketSummary.medianSpreadPct != null ? `${marketSummary.medianSpreadPct.toFixed(1)}%` : "—"}
                </p>
              </div>
              {chartData.benchmark && (
                <>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Comparables</p>
                    <p className="font-semibold tabular-nums">{chartData.benchmark.sample_size} bids</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Builders</p>
                    <p className="font-semibold tabular-nums">{chartData.benchmark.org_count} orgs</p>
                  </div>
                </>
              )}
            </div>

            <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground border-t pt-3">
              <Shield className="h-3 w-3 shrink-0" />
              Arc Intelligence uses aggregated signals only. No source bid details are exposed.
            </p>
          </div>
        )}

        {/* === MAIN CONTENT: Vendors + Documents === */}
        <div className="grid gap-6 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
          {/* Vendors */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-muted-foreground">
                Vendors ({inviteList.length})
              </h3>
              <Dialog open={inviteDialogOpen} onOpenChange={(open) => {
                setInviteDialogOpen(open)
                if (!open) {
                  setSelectedCompanyIds(new Set())
                  setCompanySearch("")
                  setEmailInvites([])
                  setNewEmailInput("")
                  setNewCompanyNameInput("")
                  setTradeFilter(normalizeTrade(current.trade) || "all")
                }
              }}>
                <DialogTrigger asChild>
                  <Button size="sm" className="h-8">
                    <Plus className="mr-1.5 h-3.5 w-3.5" />Invite
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>Invite vendors</DialogTitle>
                    <DialogDescription>Select companies to invite or add new vendors by email.</DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="flex gap-2">
                      <Select value={tradeFilter} onValueChange={setTradeFilter}>
                        <SelectTrigger className="w-[140px]">
                          <SelectValue placeholder="All trades" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All trades</SelectItem>
                          {availableTrades.map((t) => (
                            <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input value={companySearch} onChange={(e) => setCompanySearch(e.target.value)} placeholder="Search companies..." className="pl-9" />
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">
                        {selectedCompanyIds.size} selected{emailInvites.length > 0 && ` + ${emailInvites.length} by email`}
                      </span>
                      <div className="flex gap-2">
                        <Button type="button" variant="ghost" size="sm" onClick={selectAllFiltered} className="h-7 text-xs">Select all</Button>
                        {(selectedCompanyIds.size > 0 || emailInvites.length > 0) && (
                          <Button type="button" variant="ghost" size="sm" onClick={clearSelection} className="h-7 text-xs">Clear</Button>
                        )}
                      </div>
                    </div>
                    <ScrollArea className="h-[280px] rounded-md border">
                      <div className="p-2">
                        {filteredCompanies.length === 0 ? (
                          <p className="py-6 text-center text-sm text-muted-foreground">No companies found</p>
                        ) : (
                          <div className="space-y-1">
                            {filteredCompanies.map((company) => {
                              const isAlreadyInvited = invitedCompanyIds.has(company.id)
                              const isSelected = selectedCompanyIds.has(company.id)
                              const isVendor = vendorCompanyIds.has(company.id)
                              const contact = getCompanyContactInfo(company.id)
                              const hasEmail = !!(contact?.email || company.email)
                              return (
                                <label key={company.id} className={cn("flex items-center gap-3 rounded-md px-3 py-2 cursor-pointer transition-colors", isAlreadyInvited ? "opacity-50 cursor-not-allowed bg-muted/50" : isSelected ? "bg-accent" : "hover:bg-muted/50")}>
                                  <Checkbox checked={isSelected} disabled={isAlreadyInvited} onCheckedChange={() => { if (!isAlreadyInvited) toggleCompanySelection(company.id) }} />
                                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                                    <Building2 className="h-4 w-4 text-muted-foreground" />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <p className="text-sm font-medium truncate">{company.name}</p>
                                      {isVendor && <Badge variant="secondary" className="text-[10px] px-1 py-0">Vendor</Badge>}
                                      {isAlreadyInvited && <Badge variant="outline" className="text-[10px] px-1 py-0 bg-blue-500/10 text-blue-600">Invited</Badge>}
                                    </div>
                                    <p className="text-xs text-muted-foreground truncate">
                                      {contact?.full_name ? `${contact.full_name}${contact.email ? ` · ${contact.email}` : ""}` : company.email || "No contact"}
                                    </p>
                                  </div>
                                  {!hasEmail && !isAlreadyInvited && (
                                    <Tooltip><TooltipTrigger asChild><Mail className="h-4 w-4 text-amber-500" /></TooltipTrigger><TooltipContent>No email</TooltipContent></Tooltip>
                                  )}
                                </label>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </ScrollArea>
                    <div className="space-y-3 rounded-md border p-3">
                      <p className="text-sm font-medium">Invite by email</p>
                      <div className="flex gap-2">
                        <Input value={newEmailInput} onChange={(e) => setNewEmailInput(e.target.value)} placeholder="email@company.com" type="email" className="flex-1" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEmailInvite() } }} />
                        <Input value={newCompanyNameInput} onChange={(e) => setNewCompanyNameInput(e.target.value)} placeholder="Company" className="w-28" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEmailInvite() } }} />
                        <Button type="button" variant="outline" size="sm" onClick={addEmailInvite} disabled={!newEmailInput.trim()}>Add</Button>
                      </div>
                      {emailInvites.length > 0 && (
                        <div className="space-y-1">
                          {emailInvites.map((item) => (
                            <div key={item.email} className="flex items-center justify-between gap-2 rounded bg-muted/50 px-2 py-1.5 text-sm">
                              <div className="flex items-center gap-2 min-w-0">
                                <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                <span className="truncate">{item.email}</span>
                                {item.companyName && <span className="text-muted-foreground truncate">({item.companyName})</span>}
                              </div>
                              <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => removeEmailInvite(item.email)}><X className="h-3.5 w-3.5" /></Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <label className="flex items-center gap-3 rounded-md border p-3 cursor-pointer hover:bg-muted/50">
                      <Checkbox checked={sendEmails} onCheckedChange={(checked) => setSendEmails(checked === true)} />
                      <div className="flex-1">
                        <p className="text-sm font-medium">Send invitation emails</p>
                        <p className="text-xs text-muted-foreground">Automatically email vendors with the bid link</p>
                      </div>
                    </label>
                  </div>
                  <DialogFooter>
                    <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
                    <Button onClick={handleBulkInvite} disabled={isInviting || totalInviteCount === 0}>
                      {isInviting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {totalInviteCount === 0 ? "Select vendors" : `Invite ${totalInviteCount}`}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>

            {inviteList.length === 0 ? (
              <div className="flex items-center justify-center rounded-lg border border-dashed p-12 text-center">
                <div className="flex flex-col items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                    <Building2 className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="font-medium">No vendors invited yet</p>
                    <p className="text-sm text-muted-foreground">Invite vendors to start receiving bids.</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {inviteList.map((invite) => {
                  const submission = submissionByInviteId.get(invite.id)
                  const statusInfo = getVendorStatusInfo(invite, submission)
                  const accessInfo = getInviteAccessSummary(invite)
                  const intelligenceInfo = getPriceIntelligenceSummary(submission)
                  const isAwarded = submission?.is_awarded === true

                  return (
                    <div
                      key={invite.id}
                      className={cn(
                        "group flex items-center gap-4 rounded-lg border bg-card px-4 py-3 transition-colors hover:bg-muted/30",
                        isAwarded && "border-amber-500/30 bg-amber-500/[0.03]"
                      )}
                    >
                      {/* Status dot */}
                      <div className={cn(
                        "h-2.5 w-2.5 rounded-full shrink-0",
                        isAwarded ? "bg-amber-500" : submission ? "bg-emerald-500" : invite.status === "viewed" ? "bg-violet-500" : invite.status === "declined" ? "bg-rose-500" : invite.status === "sent" ? "bg-blue-500" : "bg-muted-foreground/40"
                      )} />

                      {/* Company info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium truncate">{invite.company?.name ?? "Unknown"}</p>
                          {isAwarded && (
                            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/15 text-amber-600 text-[10px] px-1.5 py-0">
                              <Trophy className="mr-0.5 h-2.5 w-2.5" />Awarded
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
                          {invite.contact?.full_name ?? invite.invite_email ?? "No contact"}
                          <span className="mx-1 text-border">·</span>
                          <span className={accessInfo.color}>{accessInfo.label}</span>
                        </p>
                      </div>

                      {/* Status + activity */}
                      <div className="hidden sm:block w-28 shrink-0">
                        <Badge variant="outline" className={cn("capitalize text-[10px]", statusInfo.color)}>
                          {statusInfo.status}
                        </Badge>
                        <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{statusInfo.activity}</p>
                      </div>

                      {/* Amount + market signal */}
                      <div className="text-right w-28 shrink-0">
                        {submission ? (
                          <>
                            <button
                              type="button"
                              className="text-sm font-semibold tabular-nums hover:underline"
                              onClick={() => openSubmissionSheet(submission)}
                            >
                              {formatCurrency(submission.total_cents)}
                            </button>
                            <div className="flex items-center justify-end gap-1.5 mt-0.5">
                              <div className={cn("h-1.5 w-1.5 rounded-full", signalDotColor(intelligenceInfo.signal))} />
                              <span className="text-[11px] text-muted-foreground">{intelligenceInfo.compactLabel}</span>
                            </div>
                          </>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                        {submission && current.status !== "awarded" && submission.is_current && submission.total_cents != null && (
                          <Button size="sm" variant="outline" onClick={() => openAwardDialog(submission)} className="h-7 text-xs">Award</Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-7 w-7"><MoreHorizontal className="h-4 w-4" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {submission && <DropdownMenuItem onSelect={() => openSubmissionSheet(submission)}><Eye className="mr-2 h-4 w-4" />View submission</DropdownMenuItem>}
                            <DropdownMenuItem onClick={() => handleGenerateLink(invite)}><Copy className="mr-2 h-4 w-4" />Copy link</DropdownMenuItem>
                            {(invite.invite_email || invite.contact?.email) && <DropdownMenuItem><Mail className="mr-2 h-4 w-4" />Resend</DropdownMenuItem>}
                            <DropdownMenuSeparator />
                            {(invite.active_access_count ?? 0) > 0 && (
                              <DropdownMenuItem onClick={() => handlePauseInviteAccess(invite)}><Ban className="mr-2 h-4 w-4" />Pause access</DropdownMenuItem>
                            )}
                            {(invite.paused_access_count ?? 0) > 0 && (
                              <DropdownMenuItem onClick={() => handleResumeInviteAccess(invite)}><CheckCircle2 className="mr-2 h-4 w-4" />Resume access</DropdownMenuItem>
                            )}
                            {(invite.access_total ?? 0) > 0 && (
                              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => handleRevokeInviteAccess(invite)}>
                                <Trash2 className="mr-2 h-4 w-4" />Revoke all links
                              </DropdownMenuItem>
                            )}
                            {(invite.access_total ?? 0) > 0 && (
                              <DropdownMenuItem onClick={() => handleSetInviteRequireAccount(invite, !(invite.require_account_enforced ?? false))}>
                                <Settings className="mr-2 h-4 w-4" />{invite.require_account_enforced ? "Allow link-only access" : "Require account access"}
                              </DropdownMenuItem>
                            )}
                            {(invite.linked_account_count ?? 0) > 0 && <DropdownMenuSeparator />}
                            {(invite.linked_active_account_count ?? 0) > 0 && (
                              <DropdownMenuItem onClick={() => handlePauseInviteAccounts(invite)}><Ban className="mr-2 h-4 w-4" />Pause linked accounts</DropdownMenuItem>
                            )}
                            {(invite.linked_paused_account_count ?? 0) > 0 && (
                              <DropdownMenuItem onClick={() => handleResumeInviteAccounts(invite)}><CheckCircle2 className="mr-2 h-4 w-4" />Resume linked accounts</DropdownMenuItem>
                            )}
                            {(invite.linked_account_count ?? 0) > 0 && (
                              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => handleRevokeInviteAccounts(invite)}>
                                <Trash2 className="mr-2 h-4 w-4" />Revoke linked accounts
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Documents Sidebar */}
          <div
            className="flex flex-col lg:min-h-0"
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileInputChange}
              accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.gif,.webp,.dwg,.dxf,.txt,.csv,.zip"
            />
            <div className="rounded-lg border bg-card flex flex-col min-h-[300px] lg:h-full">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <h3 className="text-sm font-medium">Documents</h3>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7" disabled={isUploading}>
                      {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                      <Upload className="mr-2 h-4 w-4" />Upload new file
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setProjectFilesSheetOpen(true)}>
                      <FolderOpen className="mr-2 h-4 w-4" />Add from project files
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                {packageAttachments.length === 0 ? (
                  <div
                    className={cn(
                      "flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center cursor-pointer transition-colors h-full min-h-[120px]",
                      isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50"
                    )}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="h-5 w-5 text-muted-foreground mb-1.5" />
                    <p className="text-xs text-muted-foreground">{isDragging ? "Drop files here" : "Drop files or click to upload"}</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {attachmentsTree.children.map((node) => renderFolderNode(node))}
                    {attachmentsTree.files.length > 0 && (
                      <div className="rounded-md border bg-background/60">
                        <div className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Unsorted</div>
                        <div className="p-1">
                          {attachmentsTree.files.map((attachment) => renderDocumentAttachmentRow(attachment))}
                        </div>
                      </div>
                    )}
                    {!hasDocumentTreeContent && (
                      <p className="py-4 text-center text-sm text-muted-foreground">No linked files to show.</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* File Viewer */}
        <FileViewer
          file={viewerFile}
          files={previewableFiles}
          open={viewerOpen}
          onOpenChange={setViewerOpen}
          onDownload={(f) => {
            const attachment = packageAttachments.find((a) => a.id === f.id)
            if (attachment) handleFileDownload(attachment)
          }}
        />

        {/* Addendum Dialog */}
        <Dialog open={addendumDialogOpen} onOpenChange={setAddendumDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Issue addendum</DialogTitle>
              <DialogDescription>Create an amendment to this bid package. Vendors will be notified.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input value={addendumTitle} onChange={(e) => setAddendumTitle(e.target.value)} placeholder="e.g. Updated specifications" />
              </div>
              <div className="space-y-2">
                <Label>Message</Label>
                <Textarea value={addendumMessage} onChange={(e) => setAddendumMessage(e.target.value)} placeholder="Describe the changes..." rows={4} />
              </div>
            </div>
            <DialogFooter>
              <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
              <Button onClick={handleAddendum} disabled={isAddingAddendum}>
                {isAddingAddendum && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Issue addendum
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Award Confirmation Dialog */}
        <AlertDialog open={awardDialogOpen} onOpenChange={setAwardDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Award this bid?</AlertDialogTitle>
              <AlertDialogDescription>
                This will award the bid to <span className="font-medium text-foreground">{selectedSubmission?.invite?.company?.name}</span> for <span className="font-medium text-foreground">{formatCurrency(selectedSubmission?.total_cents)}</span>. A commitment will be created automatically.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleAward} disabled={isAwarding}>
                {isAwarding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Award bid
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  )
}
