"use client"

import { useMemo, useState } from "react"

import type { ProposalInput } from "@/lib/validation/proposals"
import type { Project } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"

const DEFAULT_LINE = { description: "", quantity: 1, unit_cost_cents: 0 }

interface ProposalCreateSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Project[]
  onCreate: (input: ProposalInput) => Promise<void> | void
  loading?: boolean
}

export function ProposalCreateSheet({ open, onOpenChange, projects, onCreate, loading }: ProposalCreateSheetProps) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "")
  const [title, setTitle] = useState("")
  const [summary, setSummary] = useState("")
  const [terms, setTerms] = useState("")
  const [validUntil, setValidUntil] = useState("")
  const [markupPercent, setMarkupPercent] = useState<number | undefined>()
  const [taxRate, setTaxRate] = useState<number | undefined>()
  const [lines, setLines] = useState<typeof DEFAULT_LINE[]>([DEFAULT_LINE])

  const total = useMemo(() => {
    return lines.reduce((sum, line) => sum + (line.unit_cost_cents ?? 0) * (line.quantity ?? 1), 0)
  }, [lines])

  const handleLineChange = (idx: number, key: keyof typeof DEFAULT_LINE, value: string) => {
    setLines((prev) =>
      prev.map((line, i) =>
        i === idx
          ? { ...line, [key]: key === "description" ? value : Number(value) || 0 }
          : line,
      ),
    )
  }

  const addLine = () => setLines((prev) => [...prev, DEFAULT_LINE])
  const removeLine = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx))

  const handleCreate = () => {
    if (!projectId) return
    if (!title.trim()) return
    const validLines = lines.filter((l) => l.description.trim())
    if (!validLines.length) return

    const payload: ProposalInput = {
      project_id: projectId,
      title: title.trim(),
      summary: summary || undefined,
      terms: terms || undefined,
      valid_until: validUntil || undefined,
      markup_percent: markupPercent,
      tax_rate: taxRate,
      lines: validLines.map((line) => ({
        description: line.description,
        quantity: line.quantity || 1,
        unit_cost_cents: line.unit_cost_cents || 0,
        line_type: "item",
      })),
    }
    onCreate(payload)
  }

  const resetForm = () => {
    setTitle("")
    setSummary("")
    setTerms("")
    setValidUntil("")
    setMarkupPercent(undefined)
    setTaxRate(undefined)
    setLines([DEFAULT_LINE])
  }

  return (
    <Sheet open={open} onOpenChange={(val) => { if (!val) resetForm(); onOpenChange(val) }}>
      <SheetContent className="w-full sm:max-w-xl">
        <SheetHeader className="pb-4">
          <SheetTitle>New proposal</SheetTitle>
          <SheetDescription>Draft a proposal and get a shareable link.</SheetDescription>
        </SheetHeader>
        <ScrollArea className="h-[80vh] pr-3">
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Project</Label>
                <Select value={projectId} onValueChange={setProjectId} disabled={!projects.length}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Valid until</Label>
                <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Kitchen remodel proposal" />
            </div>
            <div className="space-y-2">
              <Label>Summary</Label>
              <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Markup %</Label>
                <Input
                  type="number"
                  value={markupPercent ?? ""}
                  onChange={(e) => setMarkupPercent(e.target.value ? Number(e.target.value) : undefined)}
                  placeholder="10"
                />
              </div>
              <div className="space-y-2">
                <Label>Tax rate %</Label>
                <Input
                  type="number"
                  value={taxRate ?? ""}
                  onChange={(e) => setTaxRate(e.target.value ? Number(e.target.value) : undefined)}
                  placeholder="8.5"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Terms</Label>
              <Textarea value={terms} onChange={(e) => setTerms(e.target.value)} rows={4} />
            </div>

            <div className="border rounded-lg p-3 space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Line items</Label>
                <Button variant="outline" size="sm" onClick={addLine}>
                  Add line
                </Button>
              </div>
              <div className="space-y-3">
                {lines.map((line, idx) => (
                  <div key={idx} className="grid gap-3 sm:grid-cols-[2fr,1fr,1fr,auto] items-end">
                    <div className="space-y-2">
                      <Label>Description</Label>
                      <Input
                        value={line.description}
                        onChange={(e) => handleLineChange(idx, "description", e.target.value)}
                        placeholder="Scope description"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Qty</Label>
                      <Input
                        type="number"
                        value={line.quantity}
                        onChange={(e) => handleLineChange(idx, "quantity", e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Unit cost (cents)</Label>
                      <Input
                        type="number"
                        value={line.unit_cost_cents}
                        onChange={(e) => handleLineChange(idx, "unit_cost_cents", e.target.value)}
                      />
                    </div>
                    <div className="flex items-center">
                      <Button variant="ghost" size="sm" onClick={() => removeLine(idx)} disabled={lines.length === 1}>
                        Remove
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Subtotal (before markup/tax)</span>
                <span className="text-lg font-semibold">${(total / 100).toLocaleString()}</span>
              </div>
            </div>
          </div>
        </ScrollArea>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={loading}>
            {loading ? "Saving..." : "Create proposal"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
