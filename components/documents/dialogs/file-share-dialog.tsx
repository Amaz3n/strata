"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Check, Copy, Link2, Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useProductTerminology } from "@/components/layout/use-product-terminology"
import { unwrapAction } from "@/lib/action-result"
import {
  createFileShareLinkAction,
  listFileShareLinksAction,
  revokeFileShareLinkAction,
  updateFileAction,
} from "@/app/(app)/documents/actions"
import type { FileShareLink, FileWithUrls } from "@/app/(app)/documents/types"
import { useDocuments } from "../documents-context"
import { shareSummary } from "./share-summary"

type ShareLinkExpiry = "7d" | "30d" | "never"

interface FileShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The document being shared. Null while the dialog is closed. */
  file: FileWithUrls | null
}

export function FileShareDialog({ open, onOpenChange, file }: FileShareDialogProps) {
  const { refreshFiles } = useDocuments()
  const terms = useProductTerminology()

  const [withClients, setWithClients] = useState(false)
  const [withSubs, setWithSubs] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  const [links, setLinks] = useState<FileShareLink[]>([])
  const [linksLoading, setLinksLoading] = useState(false)
  const [linkExpiry, setLinkExpiry] = useState<ShareLinkExpiry>("30d")
  const [linkAllowDownload, setLinkAllowDownload] = useState(true)
  const [linkLabel, setLinkLabel] = useState("")
  const [isCreatingLink, setIsCreatingLink] = useState(false)
  const [revokingLinkId, setRevokingLinkId] = useState<string | null>(null)
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !file) return

    setWithClients(Boolean(file.share_with_clients))
    setWithSubs(Boolean(file.share_with_subs))
    setLinks([])
    setLinkLabel("")
    setLinkExpiry("30d")
    setLinkAllowDownload(true)
    setLinksLoading(true)

    let cancelled = false
    listFileShareLinksAction(file.id)
      .then((loaded) => {
        if (!cancelled) setLinks(loaded)
      })
      .catch((err) => {
        console.error("Failed to load share links", err)
      })
      .finally(() => {
        if (!cancelled) setLinksLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, file])

  const handleConfirm = useCallback(async () => {
    if (!file) return
    setIsSaving(true)
    try {
      unwrapAction(
        await updateFileAction(file.id, {
          share_with_clients: withClients,
          share_with_subs: withSubs,
        }),
      )
      toast.success("Sharing updated")
      onOpenChange(false)
      await refreshFiles({ invalidateCache: true })
    } catch (error) {
      console.error("Failed to update sharing:", error)
      toast.error("Failed to update sharing")
    } finally {
      setIsSaving(false)
    }
  }, [file, withClients, withSubs, onOpenChange, refreshFiles])

  const handleCreateLink = useCallback(async () => {
    if (!file) return
    setIsCreatingLink(true)
    try {
      const now = new Date()
      const expires_at =
        linkExpiry === "never"
          ? null
          : new Date(
              now.getTime() + (linkExpiry === "7d" ? 7 : 30) * 24 * 60 * 60 * 1000,
            ).toISOString()
      const link = unwrapAction(
        await createFileShareLinkAction({
          file_id: file.id,
          label: linkLabel.trim() || null,
          expires_at,
          allow_download: linkAllowDownload,
        }),
      )
      setLinks((prev) => [link, ...prev])
      setLinkLabel("")
      const origin = typeof window !== "undefined" ? window.location.origin : ""
      try {
        await navigator.clipboard.writeText(`${origin}/f/${link.token}`)
        setCopiedLinkId(link.id)
        setTimeout(
          () => setCopiedLinkId((prev) => (prev === link.id ? null : prev)),
          2000,
        )
        toast.success("Link created and copied")
      } catch {
        toast.success("Link created")
      }
    } catch (error) {
      console.error("Failed to create share link", error)
      toast.error(error instanceof Error ? error.message : "Failed to create share link")
    } finally {
      setIsCreatingLink(false)
    }
  }, [file, linkExpiry, linkAllowDownload, linkLabel])

  const handleCopyLink = useCallback(async (link: FileShareLink) => {
    const origin = typeof window !== "undefined" ? window.location.origin : ""
    try {
      await navigator.clipboard.writeText(`${origin}/f/${link.token}`)
      setCopiedLinkId(link.id)
      setTimeout(
        () => setCopiedLinkId((prev) => (prev === link.id ? null : prev)),
        2000,
      )
    } catch (err) {
      console.error("Copy failed", err)
      toast.error("Copy failed")
    }
  }, [])

  const handleRevokeLink = useCallback(async (link: FileShareLink) => {
    setRevokingLinkId(link.id)
    try {
      unwrapAction(await revokeFileShareLinkAction(link.id))
      setLinks((prev) =>
        prev.map((item) =>
          item.id === link.id
            ? { ...item, revoked_at: new Date().toISOString(), is_active: false }
            : item,
        ),
      )
      toast.success("Link revoked")
    } catch (error) {
      console.error("Failed to revoke share link", error)
      toast.error(error instanceof Error ? error.message : "Failed to revoke link")
    } finally {
      setRevokingLinkId(null)
    }
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share</DialogTitle>
          {file ? (
            <DialogDescription className="truncate">{file.file_name}</DialogDescription>
          ) : null}
        </DialogHeader>
        <div className="max-h-[70vh] space-y-5 overflow-y-auto py-1 pr-1">
          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Portals
            </p>
            <div className="divide-y rounded-lg border">
              <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{terms.ownerPortal}</p>
                  <p className="text-xs text-muted-foreground">
                    Accessible to {terms.owners.toLowerCase()} on the {terms.ownerPortal.toLowerCase()}.
                  </p>
                </div>
                <Switch
                  checked={withClients}
                  onCheckedChange={(value) => setWithClients(Boolean(value))}
                  disabled={isSaving}
                />
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Subcontractor portal</p>
                  <p className="text-xs text-muted-foreground">
                    Accessible to subcontractors on the subcontractor portal.
                  </p>
                </div>
                <Switch
                  checked={withSubs}
                  onCheckedChange={(value) => setWithSubs(Boolean(value))}
                  disabled={isSaving}
                />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              {shareSummary(withClients, withSubs, terms.owners)}
            </p>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Public links
              </p>
              <p className="text-xs text-muted-foreground">Anyone with the link</p>
            </div>

            <div className="rounded-lg border p-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[10rem] flex-1">
                  <Label className="text-xs text-muted-foreground">Label (optional)</Label>
                  <Input
                    value={linkLabel}
                    onChange={(event) => setLinkLabel(event.target.value)}
                    placeholder="e.g. Inspector, Lender"
                    disabled={isCreatingLink}
                    className="h-9"
                  />
                </div>
                <div className="w-[7rem]">
                  <Label className="text-xs text-muted-foreground">Expires</Label>
                  <Select
                    value={linkExpiry}
                    onValueChange={(value) => setLinkExpiry(value as ShareLinkExpiry)}
                    disabled={isCreatingLink}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="7d">7 days</SelectItem>
                      <SelectItem value="30d">30 days</SelectItem>
                      <SelectItem value="never">Never</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <label className="mt-3 flex cursor-pointer items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm">Allow download</p>
                  <p className="text-xs text-muted-foreground">Off = view/preview only.</p>
                </div>
                <Switch
                  checked={linkAllowDownload}
                  onCheckedChange={(value) => setLinkAllowDownload(Boolean(value))}
                  disabled={isCreatingLink}
                />
              </label>
              <Button
                type="button"
                onClick={handleCreateLink}
                disabled={isCreatingLink || !file}
                size="sm"
                className="mt-3 w-full"
              >
                {isCreatingLink ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating
                  </>
                ) : (
                  <>
                    <Link2 className="mr-2 h-4 w-4" />
                    Create link
                  </>
                )}
              </Button>
            </div>

            {linksLoading ? (
              <p className="px-1 text-xs text-muted-foreground">Loading links…</p>
            ) : links.length === 0 ? (
              <p className="px-1 text-xs text-muted-foreground">No public links yet.</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {links.map((link) => {
                  const expiry = link.expires_at
                    ? new Date(link.expires_at).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })
                    : "Never"
                  const statusLabel = link.revoked_at
                    ? "Revoked"
                    : !link.is_active
                      ? "Expired"
                      : `Expires ${expiry}`
                  return (
                    <li key={link.id} className="flex items-center gap-2 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{link.label || "Untitled link"}</p>
                        <p className="text-xs text-muted-foreground">
                          {statusLabel}
                          {link.allow_download ? "" : " · View only"}
                          {link.use_count > 0
                            ? ` · ${link.use_count} view${link.use_count === 1 ? "" : "s"}`
                            : ""}
                        </p>
                      </div>
                      {link.is_active ? (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => handleCopyLink(link)}
                            title="Copy link"
                          >
                            {copiedLinkId === link.id ? (
                              <Check className="h-4 w-4 text-primary" />
                            ) : (
                              <Copy className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            onClick={() => handleRevokeLink(link)}
                            disabled={revokingLinkId === link.id}
                            title="Revoke link"
                          >
                            {revokingLinkId === link.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <X className="h-4 w-4" />
                            )}
                          </Button>
                        </>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isSaving || !file}>
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving
              </>
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
