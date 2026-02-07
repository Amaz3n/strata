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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Separator } from "@/components/ui/separator"
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
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { BidStatusBadge } from "@/components/bids/bid-status-badge"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import { formatFileSize, getMimeIcon, isPreviewable } from "@/components/files/types"
import { FileViewer } from "@/components/files/file-viewer"
import {
  attachFileAction,
  detachFileLinkAction,
  listAttachmentsAction,
  uploadFileAction,
} from "@/app/(app)/files/actions"
import {
  createBidAddendumAction,
  bulkCreateBidInvitesAction,
  generateBidInviteLinkAction,
  listBidInvitesAction,
  awardBidSubmissionAction,
  updateBidPackageAction,
} from "@/app/(app)/projects/[id]/bids/actions"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { CalendarDays } from "@/components/icons"
import {
  Building2,
  Check,
  Clock,
  Copy,
  Download,
  Edit,
  ExternalLink,
  Eye,
  File,
  FileText,
  Loader2,
  Mail,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  Trophy,
  Upload,
  User,
  Users,
  X,
} from "lucide-react"

const statusOptions: BidPackageStatus[] = ["draft", "sent", "open", "closed", "awarded", "cancelled"]

function normalizeTrade(value?: string | null): string {
  return value?.trim().toLowerCase() ?? ""
}

function mapAttachments(links: any[]): AttachedFile[] {
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
  }))
}

function formatCurrency(cents: number | null | undefined): string {
  if (cents == null) return "—"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function getInviteStatusColor(status: string): string {
  switch (status) {
    case "submitted":
      return "bg-emerald-500/15 text-emerald-600 border-emerald-500/30"
    case "sent":
      return "bg-blue-500/15 text-blue-600 border-blue-500/30"
    case "viewed":
      return "bg-violet-500/15 text-violet-600 border-violet-500/30"
    case "declined":
      return "bg-rose-500/15 text-rose-600 border-rose-500/30"
    case "withdrawn":
      return "bg-slate-500/15 text-slate-600 border-slate-500/30"
    default:
      return "bg-muted text-muted-foreground border-muted"
  }
}

function getInviteStatusInfo(invite: BidInvite): { activity: string } {
  switch (invite.status) {
    case "submitted":
      return {
        activity: invite.submitted_at
          ? `Submitted ${formatDistanceToNow(new Date(invite.submitted_at), { addSuffix: true })}`
          : "Submitted",
      }
    case "viewed":
      return {
        activity: invite.last_viewed_at
          ? `Viewed ${formatDistanceToNow(new Date(invite.last_viewed_at), { addSuffix: true })}`
          : "Viewed",
      }
    case "declined":
      return {
        activity: invite.declined_at
          ? `Declined ${formatDistanceToNow(new Date(invite.declined_at), { addSuffix: true })}`
          : "Declined",
      }
    case "sent":
      return {
        activity: invite.sent_at
          ? `Sent ${formatDistanceToNow(new Date(invite.sent_at), { addSuffix: true })}`
          : "Awaiting response",
      }
    case "draft":
      return {
        activity: "Not sent yet",
      }
    default:
      return {
        activity: "—",
      }
  }
}

// Cleaner documents uploader component for bid packages
interface BidDocumentsUploaderProps {
  attachments: AttachedFile[]
  onAttach: (files: File[]) => Promise<void>
  onDetach: (linkId: string) => Promise<void>
  projectId: string
}

function BidDocumentsUploader({
  attachments,
  onAttach,
  onDetach,
  projectId,
}: BidDocumentsUploaderProps) {
  const [isUploading, setIsUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerFile, setViewerFile] = useState<any>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      setIsUploading(true)
      try {
        await onAttach(files)
        toast.success(`${files.length} file${files.length > 1 ? "s" : ""} uploaded`)
      } catch (error) {
        toast.error("Failed to upload files")
      } finally {
        setIsUploading(false)
      }
    },
    [onAttach]
  )

  const handleInputChange = useCallback(
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

  const handleDetach = useCallback(
    async (attachment: AttachedFile) => {
      try {
        await onDetach(attachment.linkId)
        toast.success(`Removed ${attachment.file_name}`)
      } catch (error) {
        toast.error("Failed to remove file")
      }
    },
    [onDetach]
  )

  const handlePreview = useCallback((attachment: AttachedFile) => {
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

  const handleDownload = useCallback((attachment: AttachedFile) => {
    if (attachment.download_url) {
      const link = document.createElement("a")
      link.href = attachment.download_url
      link.download = attachment.file_name
      link.click()
    }
  }, [])

  const previewableFiles = attachments
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

  return (
    <div
      className="space-y-4"
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
        onChange={handleInputChange}
        accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.gif,.webp,.dwg,.dxf,.txt,.csv,.zip"
      />

      {/* Upload zone */}
      <div
        className={cn(
          "relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition-all cursor-pointer",
          isDragging
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50"
        )}
        onClick={() => fileInputRef.current?.click()}
      >
        {isUploading ? (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="mt-2 text-sm font-medium">Uploading...</p>
          </>
        ) : (
          <>
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Upload className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="mt-3 text-sm font-medium">
              {isDragging ? "Drop files here" : "Drag & drop files here"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              or click to browse
            </p>
          </>
        )}
      </div>

      {/* Files grid */}
      {attachments.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {attachments.map((attachment) => (
            <div
              key={attachment.linkId}
              className="group flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent/50"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-xl">
                {getMimeIcon(attachment.mime_type)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{attachment.file_name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatFileSize(attachment.size_bytes)}
                </p>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {isPreviewable(attachment.mime_type) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={(e) => {
                      e.stopPropagation()
                      handlePreview(attachment)
                    }}
                  >
                    <Eye className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDownload(attachment)
                  }}
                >
                  <Download className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDetach(attachment)
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <FileViewer
        file={viewerFile}
        files={previewableFiles}
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        onDownload={(f) => {
          const attachment = attachments.find((a) => a.id === f.id)
          if (attachment) handleDownload(attachment)
        }}
      />
    </div>
  )
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
  const [submissionList] = useState(submissions)

  // Edit form state
  const [title, setTitle] = useState(bidPackage.title)
  const [trade, setTrade] = useState(bidPackage.trade ?? "")
  const [dueAt, setDueAt] = useState<Date | undefined>(
    bidPackage.due_at ? new Date(bidPackage.due_at) : undefined
  )
  const [status, setStatus] = useState<BidPackageStatus>(bidPackage.status)
  const [scope, setScope] = useState(bidPackage.scope ?? "")
  const [instructions, setInstructions] = useState(bidPackage.instructions ?? "")

  // Invite form state - now supports multi-select
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set())
  const [companySearch, setCompanySearch] = useState("")
  const [sendEmails, setSendEmails] = useState(true)
  const [tradeFilter, setTradeFilter] = useState<string>(normalizeTrade(bidPackage.trade) || "all")
  // Email-only invites for new vendors not in directory
  const [emailInvites, setEmailInvites] = useState<Array<{ email: string; companyName: string }>>([])
  const [newEmailInput, setNewEmailInput] = useState("")
  const [newCompanyNameInput, setNewCompanyNameInput] = useState("")

  // Addendum form state
  const [addendumTitle, setAddendumTitle] = useState("")
  const [addendumMessage, setAddendumMessage] = useState("")

  // Attachments state
  const [packageAttachments, setPackageAttachments] = useState<AttachedFile[]>([])
  const [addendumAttachments, setAddendumAttachments] = useState<Record<string, AttachedFile[]>>({})
  const [submissionAttachments, setSubmissionAttachments] = useState<Record<string, AttachedFile[]>>({})
  const [isLoadingSubmissionAttachments, setIsLoadingSubmissionAttachments] = useState(false)

  // Dialogs state
  const [editSheetOpen, setEditSheetOpen] = useState(false)
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false)
  const [addendumDialogOpen, setAddendumDialogOpen] = useState(false)
  const [awardDialogOpen, setAwardDialogOpen] = useState(false)
  const [selectedSubmission, setSelectedSubmission] = useState<BidSubmission | null>(null)
  const [submissionSheetOpen, setSubmissionSheetOpen] = useState(false)
  const [detailSubmission, setDetailSubmission] = useState<BidSubmission | null>(null)

  // Transitions
  const [isSaving, startSaving] = useTransition()
  const [isInviting, startInviting] = useTransition()
  const [isAddingAddendum, startAddingAddendum] = useTransition()
  const [isAwarding, startAwarding] = useTransition()

  // Derived state
  const vendorCompanyIds = useMemo(
    () => new Set(projectVendors.map((vendor) => vendor.company_id).filter(Boolean)),
    [projectVendors]
  )

  // Companies already invited to this bid package
  const invitedCompanyIds = useMemo(
    () => new Set(inviteList.map((inv) => inv.company_id)),
    [inviteList]
  )

  // Unique trades from all companies for the filter dropdown
  const availableTrades = useMemo(() => {
    const tradeMap = new Map<string, string>()
    const addTrade = (tradeValue?: string | null) => {
      const normalized = normalizeTrade(tradeValue)
      if (!normalized) return
      if (!tradeMap.has(normalized) && tradeValue) {
        tradeMap.set(normalized, tradeValue.trim())
      }
    }
    addTrade(bidPackage.trade)
    for (const company of companies) {
      addTrade(company.trade)
    }
    return Array.from(tradeMap.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [bidPackage.trade, companies])

  // Filtered and sorted companies for the invite dialog
  const filteredCompanies = useMemo(() => {
    const searchLower = companySearch.toLowerCase().trim()
    return companies
      .filter((company) => {
        // Filter by trade
        if (tradeFilter !== "all" && normalizeTrade(company.trade) !== tradeFilter) {
          return false
        }
        // Filter by search term
        if (searchLower && !company.name.toLowerCase().includes(searchLower)) {
          return false
        }
        return true
      })
      .sort((a, b) => {
        // Sort: project vendors first, then alphabetically
        const aIsVendor = vendorCompanyIds.has(a.id)
        const bIsVendor = vendorCompanyIds.has(b.id)
        if (aIsVendor && !bIsVendor) return -1
        if (!aIsVendor && bIsVendor) return 1
        return a.name.localeCompare(b.name)
      })
  }, [companies, companySearch, tradeFilter, vendorCompanyIds])

  // Get contact/email for a company from project vendors
  const getCompanyContactInfo = useCallback(
    (companyId: string) => {
      const vendor = projectVendors.find((v) => v.company_id === companyId && v.contact)
      return vendor?.contact ?? null
    },
    [projectVendors]
  )

  const dueDate = current.due_at ? new Date(current.due_at) : null
  const isOverdue = dueDate && isPast(dueDate) && !["awarded", "closed", "cancelled"].includes(current.status)
  const submittedCount = submissionList.filter((s) => s.status === "submitted" && s.is_current).length
  const sentInvitesCount = inviteList.filter((i) => i.status !== "draft").length

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

  const loadSubmissionAttachments = useCallback(async (submissionId: string) => {
    setIsLoadingSubmissionAttachments(true)
    try {
      const links = await listAttachmentsAction("bid_submission", submissionId)
      const attachments = mapAttachments(links)
      setSubmissionAttachments((prev) => ({ ...prev, [submissionId]: attachments }))
      return attachments
    } catch (error) {
      console.error("Failed to load submission attachments:", error)
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
          trade: trade.trim() || null,
          due_at: dueAt ? dueAt.toISOString() : null,
          status,
          scope: scope.trim() || null,
          instructions: instructions.trim() || null,
        })
        setCurrent(updated)
        setTitle(updated.title)
        setTrade(updated.trade ?? "")
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
        // Build the invite items - for each company, try to get a contact from project vendors
        const companyInviteItems = Array.from(selectedCompanyIds).map((companyId) => {
          const contact = getCompanyContactInfo(companyId)
          const company = companies.find((c) => c.id === companyId)
          return {
            company_id: companyId,
            contact_id: contact?.id ?? null,
            // Use contact email, or fall back to company email
            invite_email: contact?.email || company?.email || null,
          }
        })

        // Add email-only invites (new vendors)
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

        // Add created invites to the list
        setInviteList((prev) => [...result.created, ...prev])

        // Reset form
        setSelectedCompanyIds(new Set())
        setCompanySearch("")
        setEmailInvites([])
        setNewEmailInput("")
        setNewCompanyNameInput("")
        setInviteDialogOpen(false)

        // Show success message with details
        const successCount = result.created.length
        const failedCount = result.failed.length
        const emailCount = result.emailsSent
        const newCompanies = result.companiesCreated

        const parts: string[] = []
        if (sendEmails && emailCount > 0) {
          parts.push(`${emailCount} email${emailCount !== 1 ? "s" : ""} sent`)
        }
        if (newCompanies > 0) {
          parts.push(`${newCompanies} new compan${newCompanies !== 1 ? "ies" : "y"} added to directory`)
        }

        const failureSummary =
          failedCount > 0
            ? (() => {
                const details = result.failed
                  .slice(0, 3)
                  .map((item) => `${item.identifier}: ${item.error}`)
                  .join("; ")
                const more = failedCount > 3 ? ` (+${failedCount - 3} more)` : ""
                return `Failed: ${details}${more}`
              })()
            : ""

        const description = [parts.join(", "), failureSummary].filter(Boolean).join(" · ") || undefined

        if (failedCount > 0) {
          toast.warning(`Created ${successCount} invites, ${failedCount} failed`, {
            description,
          })
        } else {
          toast.success(`Created ${successCount} invite${successCount !== 1 ? "s" : ""}`, {
            description,
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

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error("Please enter a valid email address")
      return
    }

    // Check if already added
    if (emailInvites.some((inv) => inv.email === email)) {
      toast.error("This email has already been added")
      return
    }

    // Check if a company with this email already exists
    const existingCompany = companies.find((c) => c.email?.toLowerCase() === email)
    if (existingCompany) {
      toast.error(`A company with this email already exists: ${existingCompany.name}`, {
        description: "Select it from the list instead",
      })
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

  const handleSubmissionAttachments = useCallback(
    async (submission: BidSubmission) => {
      const existing = submissionAttachments[submission.id]
      const attachments = existing ?? (await loadSubmissionAttachments(submission.id))
      if (attachments.length === 1 && attachments[0].download_url) {
        const link = document.createElement("a")
        link.href = attachments[0].download_url
        link.download = attachments[0].file_name
        link.click()
        return
      }
      openSubmissionSheet(submission)
    },
    [loadSubmissionAttachments, openSubmissionSheet, submissionAttachments]
  )

  const handleAward = () => {
    if (!selectedSubmission) return
    startAwarding(async () => {
      try {
        await awardBidSubmissionAction(projectId, bidPackage.id, selectedSubmission.id)
        setCurrent((prev) => ({ ...prev, status: "awarded" }))
        setStatus("awarded")
        setAwardDialogOpen(false)
        setSelectedSubmission(null)
        toast.success("Bid awarded and commitment created")
      } catch (error: any) {
        toast.error("Failed to award bid", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const handleAttach = useCallback(
    async (files: File[], entityType: "bid_package" | "bid_addendum", entityId: string) => {
      for (const file of files) {
        const formData = new FormData()
        formData.append("file", file)
        formData.append("projectId", projectId)
        formData.append("category", "plans")
        const uploaded = await uploadFileAction(formData)
        await attachFileAction(uploaded.id, entityType, entityId, projectId)
      }
      if (entityType === "bid_package") {
        await loadPackageAttachments()
      } else {
        await loadAddendumAttachments()
      }
    },
    [projectId, loadPackageAttachments, loadAddendumAttachments]
  )

  const handleDetach = useCallback(
    async (linkId: string, entityType: "bid_package" | "bid_addendum") => {
      await detachFileLinkAction(linkId)
      if (entityType === "bid_package") {
        await loadPackageAttachments()
      } else {
        await loadAddendumAttachments()
      }
    },
    [loadPackageAttachments, loadAddendumAttachments]
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
  const showDetailNotes = Boolean(
    detailSubmission?.exclusions || detailSubmission?.clarifications || detailSubmission?.notes
  )

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6">
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
                  <Input
                    id="trade"
                    value={trade}
                    onChange={(e) => setTrade(e.target.value)}
                    placeholder="e.g. Electrical, Plumbing"
                  />
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
                <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
                  <div className="flex items-center gap-2">
                    <FileText className="h-5 w-5 text-primary" />
                    <SheetTitle>Bid submission</SheetTitle>
                    <Badge
                      variant="outline"
                      className={cn(
                        "capitalize",
                        detailSubmission.status === "submitted" && "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
                        detailSubmission.status === "revised" && "bg-blue-500/15 text-blue-600 border-blue-500/30"
                      )}
                    >
                      {detailSubmission.status}
                    </Badge>
                    {detailSubmission.is_current && current.status === "awarded" && (
                      <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30">
                        <Trophy className="mr-1 h-3 w-3" />
                        Awarded
                      </Badge>
                    )}
                  </div>
                  <SheetDescription className="text-left">
                    {detailCompanyName} · Version {detailSubmission.version}
                  </SheetDescription>
                </SheetHeader>
                <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="rounded-lg border bg-card p-4 space-y-2">
                      <p className="text-xs font-semibold uppercase text-muted-foreground">Vendor</p>
                      <p className="text-sm font-medium">{detailCompanyName}</p>
                      <p className="text-xs text-muted-foreground">{detailContactName}</p>
                      <p className="text-xs text-muted-foreground">{detailContactEmail}</p>
                    </div>
                    <div className="rounded-lg border bg-card p-4 space-y-2">
                      <p className="text-xs font-semibold uppercase text-muted-foreground">Submission</p>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Amount</span>
                        <span className="font-medium">{formatCurrency(detailSubmission.total_cents)}</span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Submitted</span>
                        <span className="font-medium">
                          {formatDateValue(detailSubmission.submitted_at, "MMM d, yyyy 'at' h:mm a")}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Valid until</span>
                        <span className="font-medium">
                          {formatDateValue(detailSubmission.valid_until)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Lead time</span>
                        <span className="font-medium">
                          {detailSubmission.lead_time_days != null
                            ? `${detailSubmission.lead_time_days} day${detailSubmission.lead_time_days === 1 ? "" : "s"}`
                            : "—"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Duration</span>
                        <span className="font-medium">
                          {detailSubmission.duration_days != null
                            ? `${detailSubmission.duration_days} day${detailSubmission.duration_days === 1 ? "" : "s"}`
                            : "—"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Start available</span>
                        <span className="font-medium">
                          {formatDateValue(detailSubmission.start_available_on)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <Separator />

                  <div className="space-y-3">
                    <h4 className="text-sm font-semibold">Notes & clarifications</h4>
                    {showDetailNotes ? (
                      <div className="space-y-3 text-sm">
                        {detailSubmission.exclusions && (
                          <div>
                            <p className="text-xs font-semibold uppercase text-muted-foreground">Exclusions</p>
                            <p className="mt-1 whitespace-pre-wrap">{detailSubmission.exclusions}</p>
                          </div>
                        )}
                        {detailSubmission.clarifications && (
                          <div>
                            <p className="text-xs font-semibold uppercase text-muted-foreground">Clarifications</p>
                            <p className="mt-1 whitespace-pre-wrap">{detailSubmission.clarifications}</p>
                          </div>
                        )}
                        {detailSubmission.notes && (
                          <div>
                            <p className="text-xs font-semibold uppercase text-muted-foreground">Notes</p>
                            <p className="mt-1 whitespace-pre-wrap">{detailSubmission.notes}</p>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No exclusions, clarifications, or notes provided.
                      </p>
                    )}
                  </div>

                  <Separator />

                  <div className="space-y-3">
                    <div>
                      <h4 className="text-sm font-semibold">Attachments</h4>
                      <p className="text-xs text-muted-foreground">
                        Estimate, PDFs, and any supporting documents submitted with the bid.
                      </p>
                    </div>
                    {isLoadingSubmissionAttachments && detailAttachments.length === 0 ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading attachments...
                      </div>
                    ) : (
                      <EntityAttachments
                        entityType="bid_submission"
                        entityId={detailSubmission.id}
                        projectId={projectId}
                        attachments={detailAttachments}
                        onAttach={async (_files, _linkRole) => {}}
                        onDetach={async (_linkId) => {}}
                        readOnly
                      />
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Select a submission to view details.
              </div>
            )}
          </SheetContent>
        </Sheet>

        {/* Stats Bar */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <div className={cn(
                  "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                  isOverdue ? "bg-rose-500/15 text-rose-600" : "bg-muted"
                )}>
                  <Clock className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Due</p>
                  <p className={cn("text-sm font-medium truncate", isOverdue && "text-rose-600")}>
                    {dueDate ? formatDistanceToNow(dueDate, { addSuffix: true }) : "No deadline"}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Users className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Invites</p>
                  <p className="text-sm font-medium">
                    {sentInvitesCount} sent
                    {inviteList.length > sentInvitesCount && (
                      <span className="text-muted-foreground"> · {inviteList.length - sentInvitesCount} draft</span>
                    )}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <div className={cn(
                  "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                  submittedCount > 0 ? "bg-emerald-500/15 text-emerald-600" : "bg-muted"
                )}>
                  <FileText className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Submissions</p>
                  <p className="text-sm font-medium">
                    {submittedCount} received
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <File className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Documents</p>
                  <p className="text-sm font-medium">
                    {packageAttachments.length} files · {addendumList.length} addenda
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Main Content Tabs */}
        <Tabs defaultValue="invites" className="w-full">
          <TabsList>
            <TabsTrigger value="invites">
              Invites
              {inviteList.length > 0 && (
                <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-xs">
                  {inviteList.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="submissions">
              Submissions
              {submittedCount > 0 && (
                <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-xs bg-emerald-500/15 text-emerald-600">
                  {submittedCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="documents">Documents</TabsTrigger>
            <TabsTrigger value="details">Details</TabsTrigger>
          </TabsList>

          {/* Invites Tab */}
          <TabsContent value="invites" className="mt-4 space-y-4">
            {/* Summary stats */}
            {inviteList.length > 0 && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg border bg-card p-3">
                  <p className="text-xs text-muted-foreground">Total Invited</p>
                  <p className="text-xl font-semibold">{inviteList.length}</p>
                </div>
                <div className="rounded-lg border bg-card p-3">
                  <p className="text-xs text-muted-foreground">Awaiting Response</p>
                  <p className="text-xl font-semibold text-blue-600">
                    {inviteList.filter((i) => i.status === "sent" || i.status === "viewed").length}
                  </p>
                </div>
                <div className="rounded-lg border bg-card p-3">
                  <p className="text-xs text-muted-foreground">Submitted</p>
                  <p className="text-xl font-semibold text-emerald-600">
                    {inviteList.filter((i) => i.status === "submitted").length}
                  </p>
                </div>
                <div className="rounded-lg border bg-card p-3">
                  <p className="text-xs text-muted-foreground">Declined</p>
                  <p className="text-xl font-semibold text-rose-600">
                    {inviteList.filter((i) => i.status === "declined").length}
                  </p>
                </div>
              </div>
            )}

            <Card className="border-0 shadow-none bg-transparent">
              <CardHeader className="flex flex-row items-center justify-end pb-4">
                <Dialog open={inviteDialogOpen} onOpenChange={(open) => {
                  setInviteDialogOpen(open)
                  if (!open) {
                    setSelectedCompanyIds(new Set())
                    setCompanySearch("")
                    setEmailInvites([])
                    setNewEmailInput("")
                    setNewCompanyNameInput("")
                    setTradeFilter(normalizeTrade(bidPackage.trade) || "all")
                  }
                }}>
                  <DialogTrigger asChild>
                    <Button size="sm">
                      <Plus className="mr-2 h-4 w-4" />
                      Add invites
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                      <DialogTitle>Invite vendors</DialogTitle>
                      <DialogDescription>
                        Select companies to invite or add new vendors by email.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                      {/* Trade filter and search */}
                      <div className="flex gap-2">
                        <Select value={tradeFilter} onValueChange={setTradeFilter}>
                          <SelectTrigger className="w-[140px]">
                            <SelectValue placeholder="All trades" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All trades</SelectItem>
                            {availableTrades.map((trade) => (
                              <SelectItem key={trade.value} value={trade.value}>
                                {trade.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <div className="relative flex-1">
                          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            value={companySearch}
                            onChange={(e) => setCompanySearch(e.target.value)}
                            placeholder="Search companies..."
                            className="pl-9"
                          />
                        </div>
                      </div>

                      {/* Selection actions */}
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">
                          {selectedCompanyIds.size} from directory
                          {emailInvites.length > 0 && ` + ${emailInvites.length} by email`}
                        </span>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={selectAllFiltered}
                            className="h-7 text-xs"
                          >
                            Select all
                          </Button>
                          {(selectedCompanyIds.size > 0 || emailInvites.length > 0) && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={clearSelection}
                              className="h-7 text-xs"
                            >
                              Clear
                            </Button>
                          )}
                        </div>
                      </div>

                      {/* Company list with checkboxes */}
                      <ScrollArea className="h-[280px] rounded-md border">
                        <div className="p-2">
                          {filteredCompanies.length === 0 ? (
                            <p className="py-6 text-center text-sm text-muted-foreground">
                              No companies found
                            </p>
                          ) : (
                            <div className="space-y-1">
                              {filteredCompanies.map((company) => {
                                const isAlreadyInvited = invitedCompanyIds.has(company.id)
                                const isSelected = selectedCompanyIds.has(company.id)
                                const isVendor = vendorCompanyIds.has(company.id)
                                const contact = getCompanyContactInfo(company.id)
                                const hasEmail = !!(contact?.email || company.email)

                                return (
                                  <label
                                    key={company.id}
                                    className={cn(
                                      "flex items-center gap-3 rounded-md px-3 py-2 cursor-pointer transition-colors",
                                      isAlreadyInvited
                                        ? "opacity-50 cursor-not-allowed bg-muted/50"
                                        : isSelected
                                          ? "bg-accent"
                                          : "hover:bg-muted/50"
                                    )}
                                  >
                                    <Checkbox
                                      checked={isSelected}
                                      disabled={isAlreadyInvited}
                                      onCheckedChange={() => {
                                        if (!isAlreadyInvited) {
                                          toggleCompanySelection(company.id)
                                        }
                                      }}
                                    />
                                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                                      <Building2 className="h-4 w-4 text-muted-foreground" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2">
                                        <p className="text-sm font-medium truncate">{company.name}</p>
                                        {company.trade && (
                                          <Badge variant="outline" className="text-[10px] px-1 py-0 text-muted-foreground">
                                            {company.trade}
                                          </Badge>
                                        )}
                                        {isVendor && (
                                          <Badge variant="secondary" className="text-[10px] px-1 py-0">
                                            Vendor
                                          </Badge>
                                        )}
                                        {isAlreadyInvited && (
                                          <Badge variant="outline" className="text-[10px] px-1 py-0 bg-blue-500/10 text-blue-600 border-blue-500/20">
                                            Invited
                                          </Badge>
                                        )}
                                      </div>
                                      <p className="text-xs text-muted-foreground truncate">
                                        {contact?.full_name
                                          ? `${contact.full_name}${contact.email ? ` · ${contact.email}` : ""}`
                                          : company.email || "No contact"}
                                      </p>
                                    </div>
                                    {!hasEmail && !isAlreadyInvited && (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <Mail className="h-4 w-4 text-amber-500" />
                                        </TooltipTrigger>
                                        <TooltipContent>No email address</TooltipContent>
                                      </Tooltip>
                                    )}
                                  </label>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      </ScrollArea>

                      {/* Invite by email - for new vendors */}
                      <div className="space-y-3 rounded-md border p-3">
                        <div className="flex items-center gap-2">
                          <Mail className="h-4 w-4 text-muted-foreground" />
                          <p className="text-sm font-medium">Invite by email</p>
                          <span className="text-xs text-muted-foreground">(vendors not in directory)</span>
                        </div>
                        <div className="flex gap-2">
                          <Input
                            value={newEmailInput}
                            onChange={(e) => setNewEmailInput(e.target.value)}
                            placeholder="email@company.com"
                            type="email"
                            className="flex-1"
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault()
                                addEmailInvite()
                              }
                            }}
                          />
                          <Input
                            value={newCompanyNameInput}
                            onChange={(e) => setNewCompanyNameInput(e.target.value)}
                            placeholder="Company name (optional)"
                            className="flex-1"
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault()
                                addEmailInvite()
                              }
                            }}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={addEmailInvite}
                            disabled={!newEmailInput.trim()}
                          >
                            Add
                          </Button>
                        </div>
                        {emailInvites.length > 0 && (
                          <div className="space-y-1">
                            {emailInvites.map((item) => (
                              <div
                                key={item.email}
                                className="flex items-center justify-between gap-2 rounded bg-muted/50 px-2 py-1.5 text-sm"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                  <span className="truncate">{item.email}</span>
                                  {item.companyName && (
                                    <span className="text-muted-foreground truncate">({item.companyName})</span>
                                  )}
                                </div>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 w-6 p-0 shrink-0"
                                  onClick={() => removeEmailInvite(item.email)}
                                >
                                  <span className="sr-only">Remove</span>
                                  <X className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            ))}
                          </div>
                        )}
                        <p className="text-xs text-muted-foreground">
                          New vendors will be added to your directory automatically.
                        </p>
                      </div>

                      {/* Send emails toggle */}
                      <label className="flex items-center gap-3 rounded-md border p-3 cursor-pointer hover:bg-muted/50">
                        <Checkbox
                          checked={sendEmails}
                          onCheckedChange={(checked) => setSendEmails(checked === true)}
                        />
                        <div className="flex-1">
                          <p className="text-sm font-medium">Send invitation emails</p>
                          <p className="text-xs text-muted-foreground">
                            Automatically email vendors with the bid link
                          </p>
                        </div>
                        <Mail className="h-4 w-4 text-muted-foreground" />
                      </label>
                    </div>
                    <DialogFooter>
                      <DialogClose asChild>
                        <Button variant="outline">Cancel</Button>
                      </DialogClose>
                      <Button onClick={handleBulkInvite} disabled={isInviting || totalInviteCount === 0}>
                        {isInviting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {totalInviteCount === 0
                          ? "Select companies or add emails"
                          : `Invite ${totalInviteCount} vendor${totalInviteCount === 1 ? "" : "s"}`}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardHeader>
              <CardContent className="p-0">
                {inviteList.length === 0 ? (
                  <div className="p-6">
                    <Empty className="border">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <Users />
                        </EmptyMedia>
                        <EmptyTitle>No invites yet</EmptyTitle>
                        <EmptyDescription>
                          Add vendors to invite them to submit bids for this package.
                        </EmptyDescription>
                      </EmptyHeader>
                      <Button size="sm" onClick={() => setInviteDialogOpen(true)}>
                        <Plus className="mr-2 h-4 w-4" />
                        Add invites
                      </Button>
                    </Empty>
                  </div>
                ) : (
                  <div className="rounded-lg border overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow className="divide-x">
                          <TableHead className="px-4 py-4">Company</TableHead>
                          <TableHead className="px-4 py-4 hidden sm:table-cell">Contact</TableHead>
                          <TableHead className="px-4 py-4">Status</TableHead>
                          <TableHead className="px-4 py-4 hidden md:table-cell">Activity</TableHead>
                          <TableHead className="px-4 py-4 w-[120px] text-right">
                            <span className="sr-only">Actions</span>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {inviteList.map((invite) => {
                          const statusInfo = getInviteStatusInfo(invite)
                          return (
                            <TableRow key={invite.id} className="group divide-x hover:bg-muted/40">
                              <TableCell className="px-4 py-4">
                                <div className="flex items-center gap-3">
                                  <div className={cn(
                                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                                    invite.status === "submitted" ? "bg-emerald-500/15" :
                                    invite.status === "viewed" ? "bg-violet-500/15" :
                                    invite.status === "declined" ? "bg-rose-500/15" :
                                    "bg-muted"
                                  )}>
                                    <Building2 className={cn(
                                      "h-4 w-4",
                                      invite.status === "submitted" ? "text-emerald-600" :
                                      invite.status === "viewed" ? "text-violet-600" :
                                      invite.status === "declined" ? "text-rose-600" :
                                      "text-muted-foreground"
                                    )} />
                                  </div>
                                  <div className="min-w-0">
                                    <p className="text-sm font-medium truncate">
                                      {invite.company?.name ?? "Unknown company"}
                                    </p>
                                    <p className="text-xs text-muted-foreground truncate sm:hidden">
                                      {invite.contact?.full_name ?? invite.invite_email ?? "No contact"}
                                    </p>
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell className="px-4 py-4 hidden sm:table-cell">
                                <div className="min-w-0">
                                  {invite.contact?.full_name ? (
                                    <>
                                      <p className="text-sm truncate">{invite.contact.full_name}</p>
                                      <p className="text-xs text-muted-foreground truncate">
                                        {invite.contact.email ?? invite.invite_email ?? ""}
                                      </p>
                                    </>
                                  ) : invite.invite_email ? (
                                    <p className="text-sm truncate">{invite.invite_email}</p>
                                  ) : (
                                    <p className="text-sm text-muted-foreground">—</p>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="px-4 py-4">
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    "capitalize whitespace-nowrap",
                                    getInviteStatusColor(invite.status)
                                  )}
                                >
                                  {invite.status}
                                </Badge>
                              </TableCell>
                              <TableCell className="px-4 py-4 hidden md:table-cell">
                                <p className="text-xs text-muted-foreground whitespace-nowrap">
                                  {statusInfo.activity}
                                </p>
                              </TableCell>
                              <TableCell className="px-4 py-4">
                                <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8"
                                        onClick={() => handleGenerateLink(invite)}
                                      >
                                        <Copy className="h-4 w-4" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Copy bid link</TooltipContent>
                                  </Tooltip>
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button variant="ghost" size="icon" className="h-8 w-8">
                                        <MoreHorizontal className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      <DropdownMenuItem onClick={() => handleGenerateLink(invite)}>
                                        <Copy className="mr-2 h-4 w-4" />
                                        Copy bid link
                                      </DropdownMenuItem>
                                      {(invite.invite_email || invite.contact?.email) && (
                                        <DropdownMenuItem>
                                          <Mail className="mr-2 h-4 w-4" />
                                          Resend invite
                                        </DropdownMenuItem>
                                      )}
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem>
                                        <ExternalLink className="mr-2 h-4 w-4" />
                                        View company
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Submissions Tab */}
          <TabsContent value="submissions" className="mt-4 space-y-4">
            {/* Mobile: Card layout */}
            <div className="md:hidden space-y-3">
              {submissionList.length === 0 ? (
                <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <FileText className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="font-medium">No submissions yet</p>
                      <p className="text-sm">Submissions will appear here once vendors respond.</p>
                    </div>
                  </div>
                </div>
              ) : (
                submissionList.map((submission) => (
                  <div
                    key={submission.id}
                    className={cn(
                      "rounded-lg border bg-card p-4 transition-colors",
                      submission.is_current && current.status === "awarded" && "border-amber-200 bg-amber-50/50"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            type="button"
                            className="font-semibold truncate hover:underline text-left"
                            onClick={() => openSubmissionSheet(submission)}
                          >
                            {submission.invite?.company?.name ?? "Unknown company"}
                          </button>
                          <Badge variant="outline" className={cn(
                            "text-xs capitalize",
                            submission.status === "submitted" && "bg-emerald-500/15 text-emerald-600 border-emerald-500/30"
                          )}>
                            {submission.status}
                          </Badge>
                          {submission.is_current && current.status === "awarded" && (
                            <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30">
                              <Trophy className="mr-1 h-3 w-3" />
                              Awarded
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">
                          {submission.submitted_at
                            ? format(new Date(submission.submitted_at), "MMM d, yyyy 'at' h:mm a")
                            : "Not submitted"}
                        </p>
                        <p className="text-lg font-semibold mt-2 tabular-nums">
                          {formatCurrency(submission.total_cents)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => openSubmissionSheet(submission)}
                          aria-label="View submission details"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {current.status !== "awarded" && submission.is_current && submission.total_cents != null && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openAwardDialog(submission)}
                          >
                            <Trophy className="h-4 w-4 mr-1" />
                            Award
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Desktop: Table layout */}
            <div className="hidden md:block rounded-lg border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="divide-x">
                    <TableHead className="px-4 py-4">Vendor</TableHead>
                    <TableHead className="px-4 py-4">Contact</TableHead>
                    <TableHead className="px-4 py-4 text-center">Submitted</TableHead>
                    <TableHead className="px-4 py-4 text-right">Amount</TableHead>
                    <TableHead className="px-4 py-4 text-center">Status</TableHead>
                    <TableHead className="px-4 py-4 w-[100px]">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {submissionList.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                        <div className="flex flex-col items-center gap-4">
                          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                            <FileText className="h-6 w-6" />
                          </div>
                          <div>
                            <p className="font-medium">No submissions yet</p>
                            <p className="text-sm">Submissions will appear here once vendors respond to your invites.</p>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    submissionList.map((submission) => (
                      <TableRow
                        key={submission.id}
                        className={cn(
                          "group divide-x hover:bg-muted/40",
                          submission.is_current && current.status === "awarded" && "bg-amber-50/50"
                        )}
                      >
                        <TableCell className="px-4 py-4">
                          <div className="flex items-center gap-3">
                            <div className={cn(
                              "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                              submission.is_current && current.status === "awarded"
                                ? "bg-amber-100"
                                : submission.status === "submitted"
                                  ? "bg-emerald-500/15"
                                  : "bg-muted"
                            )}>
                              {submission.is_current && current.status === "awarded" ? (
                                <Trophy className="h-4 w-4 text-amber-600" />
                              ) : (
                                <Building2 className={cn(
                                  "h-4 w-4",
                                  submission.status === "submitted"
                                    ? "text-emerald-600"
                                    : "text-muted-foreground"
                                )} />
                              )}
                            </div>
                            <div className="min-w-0">
                              <button
                                type="button"
                                className="text-sm font-medium truncate text-left hover:underline"
                                onClick={() => openSubmissionSheet(submission)}
                              >
                                {submission.invite?.company?.name ?? "Unknown company"}
                              </button>
                              <p className="text-xs text-muted-foreground">
                                Version {submission.version}
                                {submission.is_current && (
                                  <span className="ml-1.5 text-emerald-600">(Current)</span>
                                )}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="px-4 py-4">
                          <div className="min-w-0">
                            {submission.submitted_by_name ? (
                              <>
                                <p className="text-sm truncate">{submission.submitted_by_name}</p>
                                <p className="text-xs text-muted-foreground truncate">
                                  {submission.submitted_by_email ?? ""}
                                </p>
                              </>
                            ) : (
                              <p className="text-sm text-muted-foreground">—</p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="px-4 py-4 text-center">
                          <p className="text-sm text-muted-foreground whitespace-nowrap">
                            {submission.submitted_at
                              ? format(new Date(submission.submitted_at), "MMM d, yyyy")
                              : "—"}
                          </p>
                          {submission.submitted_at && (
                            <p className="text-xs text-muted-foreground">
                              {format(new Date(submission.submitted_at), "h:mm a")}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="px-4 py-4 text-right">
                          <p className="text-sm font-semibold tabular-nums">
                            {formatCurrency(submission.total_cents)}
                          </p>
                          {submission.valid_until && (
                            <p className="text-xs text-muted-foreground">
                              Valid until {format(new Date(submission.valid_until), "MMM d")}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="px-4 py-4 text-center">
                          {submission.is_current && current.status === "awarded" ? (
                            <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30">
                              <Trophy className="mr-1 h-3 w-3" />
                              Awarded
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className={cn(
                                "capitalize whitespace-nowrap",
                                submission.status === "submitted" && "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
                                submission.status === "revised" && "bg-blue-500/15 text-blue-600 border-blue-500/30"
                              )}
                            >
                              {submission.status}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="px-4 py-4">
                          <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            {current.status !== "awarded" && submission.is_current && submission.total_cents != null && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => openAwardDialog(submission)}
                                  >
                                    <Trophy className="h-4 w-4 mr-1" />
                                    Award
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Award this bid</TooltipContent>
                              </Tooltip>
                            )}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => openSubmissionSheet(submission)}>
                                  <Eye className="mr-2 h-4 w-4" />
                                  View details
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => handleSubmissionAttachments(submission)}>
                                  <Download className="mr-2 h-4 w-4" />
                                  Download attachments
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          {/* Documents Tab */}
          <TabsContent value="documents" className="mt-4 space-y-6">
            {/* Bid Documents Section */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold">Bid Documents</h3>
                  <p className="text-xs text-muted-foreground">
                    Plans, specifications, and other documents for bidders
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  {packageAttachments.length} file{packageAttachments.length !== 1 ? "s" : ""}
                </p>
              </div>

              <BidDocumentsUploader
                attachments={packageAttachments}
                onAttach={(files) => handleAttach(files, "bid_package", bidPackage.id)}
                onDetach={(linkId) => handleDetach(linkId, "bid_package")}
                projectId={projectId}
              />
            </div>

            {/* Addenda Section */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold">Addenda</h3>
                  <p className="text-xs text-muted-foreground">
                    Amendments and clarifications to the bid package
                  </p>
                </div>
                <Dialog open={addendumDialogOpen} onOpenChange={setAddendumDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" variant="outline">
                      <Plus className="mr-2 h-4 w-4" />
                      Issue addendum
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Issue addendum</DialogTitle>
                      <DialogDescription>
                        Create an amendment to this bid package. Vendors will be notified.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                      <div className="space-y-2">
                        <Label>Title</Label>
                        <Input
                          value={addendumTitle}
                          onChange={(e) => setAddendumTitle(e.target.value)}
                          placeholder="e.g. Updated specifications"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Message</Label>
                        <Textarea
                          value={addendumMessage}
                          onChange={(e) => setAddendumMessage(e.target.value)}
                          placeholder="Describe the changes..."
                          rows={4}
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <DialogClose asChild>
                        <Button variant="outline">Cancel</Button>
                      </DialogClose>
                      <Button onClick={handleAddendum} disabled={isAddingAddendum}>
                        {isAddingAddendum && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Issue addendum
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>

              {addendumList.length === 0 ? (
                <div className="rounded-lg border border-dashed p-6 text-center">
                  <FileText className="mx-auto h-8 w-8 text-muted-foreground/50" />
                  <p className="mt-2 text-sm text-muted-foreground">No addenda issued yet</p>
                  <p className="text-xs text-muted-foreground">
                    Issue addenda to communicate changes or clarifications
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {addendumList.map((addendum) => (
                    <div
                      key={addendum.id}
                      className="rounded-lg border bg-card overflow-hidden"
                    >
                      <div className="flex items-start gap-4 p-4">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
                          <FileText className="h-5 w-5 text-amber-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="text-sm font-medium">Addendum {addendum.number}</h4>
                            {addendum.title && (
                              <>
                                <span className="text-muted-foreground">·</span>
                                <span className="text-sm truncate">{addendum.title}</span>
                              </>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Issued {addendum.issued_at && format(new Date(addendum.issued_at), "MMM d, yyyy 'at' h:mm a")}
                          </p>
                          {addendum.message && (
                            <p className="text-sm text-muted-foreground mt-2 whitespace-pre-wrap line-clamp-2">
                              {addendum.message}
                            </p>
                          )}
                        </div>
                      </div>
                      {(addendumAttachments[addendum.id]?.length > 0 || true) && (
                        <div className="border-t bg-muted/30 px-4 py-3">
                          <EntityAttachments
                            entityType="bid_addendum"
                            entityId={addendum.id}
                            projectId={projectId}
                            attachments={addendumAttachments[addendum.id] ?? []}
                            onAttach={(files) => handleAttach(files, "bid_addendum", addendum.id)}
                            onDetach={(linkId) => handleDetach(linkId, "bid_addendum")}
                            compact
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          {/* Details Tab */}
          <TabsContent value="details" className="mt-4">
            <Card className="overflow-hidden border-0 shadow-sm bg-gradient-to-br from-muted/40 via-background to-background">
              <CardHeader className="flex flex-row items-center justify-between border-b bg-muted/30">
                <div className="space-y-1">
                  <CardTitle className="text-base">Package details</CardTitle>
                  <CardDescription>Scope, schedule, and instructions for bidders</CardDescription>
                </div>
                <Button size="sm" variant="outline" onClick={() => setEditSheetOpen(true)}>
                  <Edit className="mr-2 h-4 w-4" />
                  Edit
                </Button>
              </CardHeader>
              <CardContent className="p-6 space-y-6">
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="rounded-lg border bg-card/80 p-4 space-y-2">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider">Trade</p>
                    <p className="text-sm font-medium">{current.trade || "Not specified"}</p>
                    <p className="text-xs text-muted-foreground">Primary scope classification</p>
                  </div>
                  <div className="rounded-lg border bg-card/80 p-4 space-y-2">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider">Due date</p>
                    <p className={cn("text-sm font-medium", isOverdue && "text-rose-600")}>
                      {dueDate ? format(dueDate, "MMMM d, yyyy 'at' h:mm a") : "No deadline"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {dueDate ? `Due ${formatDistanceToNow(dueDate, { addSuffix: true })}` : "Set a deadline to keep bids on track"}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-card/80 p-4 space-y-2">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider">Status</p>
                    <div>
                      <BidStatusBadge status={current.status} />
                    </div>
                    <p className="text-xs text-muted-foreground">Current package state</p>
                  </div>
                </div>

                <div className="grid gap-6 lg:grid-cols-2">
                  <div className="rounded-lg border bg-card p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider">Scope of work</p>
                      <Badge variant="outline" className="text-[10px] uppercase tracking-wide">Scope</Badge>
                    </div>
                    {current.scope ? (
                      <p className="text-sm whitespace-pre-wrap leading-relaxed">{current.scope}</p>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">No scope defined</p>
                    )}
                  </div>

                  <div className="rounded-lg border bg-card p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider">Bid instructions</p>
                      <Badge variant="outline" className="text-[10px] uppercase tracking-wide">Instructions</Badge>
                    </div>
                    {current.instructions ? (
                      <p className="text-sm whitespace-pre-wrap leading-relaxed">{current.instructions}</p>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">No instructions provided</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Award Confirmation Dialog */}
        <AlertDialog open={awardDialogOpen} onOpenChange={setAwardDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Award this bid?</AlertDialogTitle>
              <AlertDialogDescription>
                This will award the bid to{" "}
                <span className="font-medium text-foreground">
                  {selectedSubmission?.invite?.company?.name}
                </span>{" "}
                for{" "}
                <span className="font-medium text-foreground">
                  {formatCurrency(selectedSubmission?.total_cents)}
                </span>
                . A commitment will be created automatically.
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
