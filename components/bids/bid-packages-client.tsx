"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { format } from "date-fns"
import { toast } from "sonner"

import type { BidPackage } from "@/lib/services/bids"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Plus } from "@/components/icons"
import { createBidPackageAction } from "@/app/(app)/projects/[id]/bids/actions"
import { BidStatusBadge } from "@/components/bids/bid-status-badge"

interface BidPackagesClientProps {
  projectId: string
  packages: BidPackage[]
}

export function BidPackagesClient({ projectId, packages }: BidPackagesClientProps) {
  const [items, setItems] = useState(packages)
  const [search, setSearch] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [isCreating, startCreating] = useTransition()

  const [title, setTitle] = useState("")
  const [trade, setTrade] = useState("")
  const [dueAt, setDueAt] = useState("")
  const [scope, setScope] = useState("")
  const [instructions, setInstructions] = useState("")

  const filtered = useMemo(() => {
    const term = search.toLowerCase()
    return items.filter((item) => {
      const haystack = [item.title, item.trade ?? "", item.scope ?? ""].join(" ").toLowerCase()
      return !term || haystack.includes(term)
    })
  }, [items, search])

  const resetForm = () => {
    setTitle("")
    setTrade("")
    setDueAt("")
    setScope("")
    setInstructions("")
  }

  const handleCreate = () => {
    if (!title.trim()) {
      toast.error("Title is required")
      return
    }
    startCreating(async () => {
      try {
        const payload = {
          title: title.trim(),
          trade: trade.trim() || null,
          scope: scope.trim() || null,
          instructions: instructions.trim() || null,
          due_at: dueAt ? new Date(dueAt).toISOString() : null,
        }
        const created = await createBidPackageAction(projectId, payload)
        setItems((prev) => [created, ...prev])
        toast.success("Bid package created")
        resetForm()
        setCreateOpen(false)
      } catch (error: any) {
        toast.error("Failed to create package", { description: error?.message ?? "Please try again." })
      }
    })
  }

  return (
    <div className="space-y-4">
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New bid package</DialogTitle>
            <DialogDescription>Create an invite-to-bid package for this project.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Electrical - Rough & Trim" />
            </div>
            <div className="space-y-2">
              <Label>Trade</Label>
              <Input value={trade} onChange={(e) => setTrade(e.target.value)} placeholder="Electrical" />
            </div>
            <div className="space-y-2">
              <Label>Due date</Label>
              <Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Scope</Label>
              <Textarea value={scope} onChange={(e) => setScope(e.target.value)} placeholder="Scope notes" />
            </div>
            <div className="space-y-2">
              <Label>Instructions</Label>
              <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Bid instructions" />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={isCreating}>
                {isCreating ? "Creating..." : "Create package"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 items-center gap-2">
          <Input
            placeholder="Search bid packages..."
            className="w-full sm:w-72"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New package
        </Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="px-4 py-4">Package</TableHead>
              <TableHead className="px-4 py-4">Trade</TableHead>
              <TableHead className="px-4 py-4 text-center">Status</TableHead>
              <TableHead className="px-4 py-4 text-center">Invites</TableHead>
              <TableHead className="px-4 py-4 text-center">Due</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-12 text-center text-muted-foreground">
                  No bid packages yet.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((pkg) => (
                <TableRow key={pkg.id} className="divide-x hover:bg-muted/40">
                  <TableCell className="px-4 py-4">
                    <Link href={`/projects/${projectId}/bids/${pkg.id}`} className="font-medium hover:underline">
                      {pkg.title}
                    </Link>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground">{pkg.trade ?? "—"}</TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <BidStatusBadge status={pkg.status} />
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <Badge variant="secondary">{pkg.invite_count ?? 0}</Badge>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center text-sm text-muted-foreground">
                    {pkg.due_at ? format(new Date(pkg.due_at), "MMM d, h:mm a") : "—"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
