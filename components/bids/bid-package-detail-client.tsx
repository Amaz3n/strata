"use client"

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { Company, ProjectVendor } from "@/lib/types"
import type { BidAddendum, BidInvite, BidPackage, BidSubmission } from "@/lib/services/bids"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { BidStatusBadge } from "@/components/bids/bid-status-badge"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import {
  attachFileAction,
  detachFileLinkAction,
  listAttachmentsAction,
  uploadFileAction,
} from "@/app/(app)/files/actions"
import {
  createBidAddendumAction,
  createBidInviteAction,
  generateBidInviteLinkAction,
  listBidInvitesAction,
  awardBidSubmissionAction,
  updateBidPackageAction,
} from "@/app/(app)/projects/[id]/bids/actions"
import { Copy, Loader2 } from "@/components/icons"
import type { BidPackageStatus } from "@/lib/validation/bids"

const statusOptions: BidPackageStatus[] = ["draft", "sent", "open", "closed", "awarded", "cancelled"]

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

interface BidPackageDetailClientProps {
  projectId: string
  bidPackage: BidPackage
  invites: BidInvite[]
  addenda: BidAddendum[]
  submissions: BidSubmission[]
  companies: Company[]
  projectVendors: ProjectVendor[]
}

export function BidPackageDetailClient({
  projectId,
  bidPackage,
  invites,
  addenda,
  submissions,
  companies,
  projectVendors,
}: BidPackageDetailClientProps) {
  const [current, setCurrent] = useState(bidPackage)
  const [isSaving, startSaving] = useTransition()
  const [isInviting, startInviting] = useTransition()
  const [isAddingAddendum, startAddingAddendum] = useTransition()
  const [isAwarding, startAwarding] = useTransition()

  const [title, setTitle] = useState(bidPackage.title)
  const [trade, setTrade] = useState(bidPackage.trade ?? "")
  const [dueAt, setDueAt] = useState(bidPackage.due_at ? bidPackage.due_at.slice(0, 16) : "")
  const [status, setStatus] = useState<BidPackageStatus>(bidPackage.status)
  const [scope, setScope] = useState(bidPackage.scope ?? "")
  const [instructions, setInstructions] = useState(bidPackage.instructions ?? "")

  const [inviteList, setInviteList] = useState(invites)
  const [addendumList, setAddendumList] = useState(addenda)
  const [submissionList] = useState(submissions)
  const [awardingId, setAwardingId] = useState<string | null>(null)

  const [companyId, setCompanyId] = useState("")
  const [contactId, setContactId] = useState("none")
  const [inviteEmail, setInviteEmail] = useState("")

  const [addendumTitle, setAddendumTitle] = useState("")
  const [addendumMessage, setAddendumMessage] = useState("")

  const [packageAttachments, setPackageAttachments] = useState<AttachedFile[]>([])
  const [addendumAttachments, setAddendumAttachments] = useState<Record<string, AttachedFile[]>>({})

  const vendorCompanyIds = useMemo(() => new Set(projectVendors.map((vendor) => vendor.company_id).filter(Boolean)), [projectVendors])

  const selectedCompanyContacts = useMemo(() => {
    if (!companyId) return []
    return projectVendors.filter((vendor) => vendor.company_id === companyId && vendor.contact)
  }, [companyId, projectVendors])

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
          due_at: dueAt ? new Date(dueAt).toISOString() : null,
          status,
          scope: scope.trim() || null,
          instructions: instructions.trim() || null,
        })
        setCurrent(updated)
        setTitle(updated.title)
        setTrade(updated.trade ?? "")
        setDueAt(updated.due_at ? updated.due_at.slice(0, 16) : "")
        setStatus(updated.status)
        setScope(updated.scope ?? "")
        setInstructions(updated.instructions ?? "")
        toast.success("Bid package updated")
      } catch (error: any) {
        toast.error("Failed to update package", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const handleInvite = () => {
    if (!companyId) {
      toast.error("Select a company to invite")
      return
    }
    startInviting(async () => {
      try {
        const invite = await createBidInviteAction(projectId, {
          bid_package_id: bidPackage.id,
          company_id: companyId,
          contact_id: contactId === "none" ? null : contactId,
          invite_email: inviteEmail.trim() || null,
        })
        setInviteList((prev) => [invite, ...prev])
        setCompanyId("")
        setContactId("none")
        setInviteEmail("")
        toast.success("Invite created")
      } catch (error: any) {
        toast.error("Failed to create invite", { description: error?.message ?? "Please try again." })
      }
    })
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
        toast.success("Addendum issued")
      } catch (error: any) {
        toast.error("Failed to create addendum", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const handleAward = (submission: BidSubmission) => {
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
    if (!confirm("Award this bid and create a commitment?")) return

    setAwardingId(submission.id)
    startAwarding(async () => {
      try {
        await awardBidSubmissionAction(projectId, bidPackage.id, submission.id)
        setCurrent((prev) => ({ ...prev, status: "awarded" }))
        setStatus("awarded")
        toast.success("Bid awarded and commitment created")
      } catch (error: any) {
        toast.error("Failed to award bid", { description: error?.message ?? "Please try again." })
      } finally {
        setAwardingId(null)
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

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>{current.title}</CardTitle>
            <div className="text-sm text-muted-foreground">
              {current.due_at ? `Due ${format(new Date(current.due_at), "MMM d, h:mm a")}` : "No due date"}
            </div>
          </div>
          <BidStatusBadge status={current.status} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Trade</Label>
              <Input value={trade} onChange={(e) => setTrade(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Due date</Label>
              <Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={status} onValueChange={(value) => setStatus(value as BidPackageStatus)}>
                <SelectTrigger>
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
            <div className="flex items-end justify-end">
              <Button onClick={handleSave} disabled={isSaving}>
                {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Save changes
              </Button>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Scope</Label>
              <Textarea value={scope} onChange={(e) => setScope(e.target.value)} placeholder="Scope notes" />
            </div>
            <div className="space-y-2">
              <Label>Instructions</Label>
              <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Instructions" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Package files</CardTitle>
        </CardHeader>
        <CardContent>
          <EntityAttachments
            entityType="bid_package"
            entityId={bidPackage.id}
            projectId={projectId}
            attachments={packageAttachments}
            onAttach={(files) => handleAttach(files, "bid_package", bidPackage.id)}
            onDetach={(linkId) => handleDetach(linkId, "bid_package")}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invites</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>Company</Label>
              <Select value={companyId} onValueChange={setCompanyId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select company" />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((company) => (
                    <SelectItem key={company.id} value={company.id}>
                      {company.name} {vendorCompanyIds.has(company.id) ? "• Project vendor" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Contact (optional)</Label>
              <Select value={contactId} onValueChange={setContactId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select contact" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No contact</SelectItem>
                  {selectedCompanyContacts
                    .filter((vendor) => vendor.contact?.id)
                    .map((vendor) => (
                      <SelectItem key={vendor.contact?.id} value={vendor.contact?.id ?? ""}>
                        {vendor.contact?.full_name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Invite email</Label>
              <Input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="email@company.com" />
            </div>
            <div className="sm:col-span-3 flex justify-end">
              <Button onClick={handleInvite} disabled={isInviting}>
                {isInviting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Add invite
              </Button>
            </div>
          </div>
          <Separator />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead className="text-right">Link</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inviteList.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    No invites yet.
                  </TableCell>
                </TableRow>
              ) : (
                inviteList.map((invite) => (
                  <TableRow key={invite.id}>
                    <TableCell>{invite.company?.name ?? "—"}</TableCell>
                    <TableCell>
                      {invite.contact?.full_name ?? invite.invite_email ?? "—"}
                    </TableCell>
                    <TableCell className="capitalize">{invite.status}</TableCell>
                    <TableCell>
                      {invite.sent_at ? format(new Date(invite.sent_at), "MMM d") : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" onClick={() => handleGenerateLink(invite)}>
                        <Copy className="mr-2 h-4 w-4" />
                        Copy link
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Addenda</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={addendumTitle} onChange={(e) => setAddendumTitle(e.target.value)} placeholder="Addendum title" />
            </div>
            <div className="space-y-2">
              <Label>Message</Label>
              <Textarea value={addendumMessage} onChange={(e) => setAddendumMessage(e.target.value)} placeholder="Addendum notes" />
            </div>
            <div className="sm:col-span-2 flex justify-end">
              <Button onClick={handleAddendum} disabled={isAddingAddendum}>
                {isAddingAddendum ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Issue addendum
              </Button>
            </div>
          </div>
          <Separator />
          <div className="space-y-4">
            {addendumList.length === 0 ? (
              <div className="text-sm text-muted-foreground">No addenda issued yet.</div>
            ) : (
              addendumList.map((addendum) => (
                <Card key={addendum.id} className="border-dashed">
                  <CardHeader>
                    <CardTitle className="text-base">Addendum {addendum.number}</CardTitle>
                    <div className="text-xs text-muted-foreground">
                      {addendum.issued_at ? format(new Date(addendum.issued_at), "MMM d, yyyy") : ""}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {addendum.title && <div className="text-sm font-medium">{addendum.title}</div>}
                    {addendum.message && (
                      <div className="text-sm text-muted-foreground whitespace-pre-wrap">{addendum.message}</div>
                    )}
                    <EntityAttachments
                      entityType="bid_addendum"
                      entityId={addendum.id}
                      projectId={projectId}
                      attachments={addendumAttachments[addendum.id] ?? []}
                      onAttach={(files) => handleAttach(files, "bid_addendum", addendum.id)}
                      onDetach={(linkId) => handleDetach(linkId, "bid_addendum")}
                      compact
                    />
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Submissions</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead className="text-right">Award</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {submissionList.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No submissions yet.
                  </TableCell>
                </TableRow>
              ) : (
                submissionList.map((submission) => (
                  <TableRow key={submission.id}>
                    <TableCell>{submission.invite?.company?.name ?? "—"}</TableCell>
                    <TableCell className="capitalize">{submission.status}</TableCell>
                    <TableCell>v{submission.version}</TableCell>
                    <TableCell>
                      {submission.total_cents != null
                        ? (submission.total_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {submission.submitted_at ? format(new Date(submission.submitted_at), "MMM d") : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {current.status === "awarded" ? (
                        <span className="text-xs font-medium text-muted-foreground">Awarded</span>
                      ) : submission.is_current ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleAward(submission)}
                          disabled={isAwarding && awardingId === submission.id}
                        >
                          {isAwarding && awardingId === submission.id ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : null}
                          Award
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
