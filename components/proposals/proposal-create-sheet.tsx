"use client"

import { useMemo, useState } from "react"
import { format } from "date-fns"

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
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { FileText, CalendarDays, Trash2, Plus } from "@/components/icons"
import { cn } from "@/lib/utils"

const DEFAULT_LINE = { description: "", quantity: 1, unit_cost: 0 }

interface ProposalCreateSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: { id: string; name: string }[]
  allowNoProject?: boolean
  onCreate: (input: ProposalInput) => Promise<void> | void
  loading?: boolean
}

export function ProposalCreateSheet({
  open,
  onOpenChange,
  projects,
  allowNoProject = true,
  onCreate,
  loading,
}: ProposalCreateSheetProps) {
  const initialProjectId = allowNoProject ? "none" : (projects[0]?.id ?? "")
  const [projectId, setProjectId] = useState(initialProjectId)
  const [title, setTitle] = useState("")
  const [summary, setSummary] = useState("")
  const [terms, setTerms] = useState("")
  const [validUntil, setValidUntil] = useState<Date | undefined>(undefined)
  const [markupPercent, setMarkupPercent] = useState<number | undefined>()
  const [taxRate, setTaxRate] = useState<number | undefined>()
  const [lines, setLines] = useState<typeof DEFAULT_LINE[]>([DEFAULT_LINE])

  const total = useMemo(() => {
    return lines.reduce((sum, line) => sum + (line.unit_cost ?? 0) * (line.quantity ?? 1), 0)
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
    if (!title.trim()) return
    const validLines = lines.filter((l) => l.description.trim())
    if (!validLines.length) return

    const resolvedProjectId = allowNoProject && projectId === "none" ? undefined : projectId || undefined
    if (!resolvedProjectId && !allowNoProject) return

    const payload: ProposalInput = {
      project_id: resolvedProjectId,
      title: title.trim(),
      summary: summary || undefined,
      terms: terms || undefined,
      valid_until: validUntil ? format(validUntil, "yyyy-MM-dd") : undefined,
      markup_percent: markupPercent,
      tax_rate: taxRate,
      lines: validLines.map((line) => ({
        description: line.description,
        quantity: line.quantity || 1,
        unit_cost_cents: Math.round((line.unit_cost || 0) * 100), // Convert dollars to cents
        line_type: "item",
      })),
    }
    onCreate(payload)
  }

  const resetForm = () => {
    setProjectId(initialProjectId)
    setTitle("")
    setSummary("")
    setTerms("")
    setValidUntil(undefined)
    setMarkupPercent(undefined)
    setTaxRate(undefined)
    setLines([DEFAULT_LINE])
  }

  return (
    <Sheet open={open} onOpenChange={(val) => { if (!val) resetForm(); onOpenChange(val) }}>
      <SheetContent
        side="right"
        className="sm:max-w-lg w-full max-w-md ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={{
          animationDuration: '150ms',
          transitionDuration: '150ms'
        } as React.CSSProperties}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            New Proposal
          </SheetTitle>
          <SheetDescription>
            Draft a proposal and get a shareable link.
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleCreate()
          }}
          className="flex-1 flex flex-col overflow-hidden"
        >
          <ScrollArea className="flex-1 min-h-0">
            <div className="px-6 py-4 space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 min-w-0">
                  <Label>Project</Label>
                  <Select value={projectId} onValueChange={setProjectId} disabled={!projects.length && !allowNoProject}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select project" />
                    </SelectTrigger>
                    <SelectContent>
                      {allowNoProject && (
                        <SelectItem value="none">No project yet</SelectItem>
                      )}
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
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn(
                          "w-full justify-start text-left font-normal",
                          !validUntil && "text-muted-foreground"
                        )}
                      >
                        <CalendarDays className="mr-2 h-4 w-4" />
                        {validUntil ? format(validUntil, "LLL dd, y") : "Pick a date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={validUntil}
                        onSelect={setValidUntil}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
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

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm font-semibold">Line items</Label>
                    <p className="text-xs text-muted-foreground mt-0.5">Add items with quantity and unit cost</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={addLine} type="button">
                    <Plus className="h-4 w-4 mr-2" />
                    Add item
                  </Button>
                </div>

                <div className="space-y-3">
                  {lines.map((line, idx) => {
                    const lineTotal = (line.unit_cost ?? 0) * (line.quantity ?? 1)
                    return (
                      <div key={idx} className="rounded-lg border p-4 space-y-3 bg-muted/30">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 space-y-2">
                            <Label className="text-xs font-medium text-muted-foreground">Description</Label>
                            <Input
                              value={line.description}
                              onChange={(e) => handleLineChange(idx, "description", e.target.value)}
                              placeholder="Work description"
                              className="w-full"
                            />
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="mt-6 h-8 w-8"
                            onClick={() => removeLine(idx)}
                            disabled={lines.length === 1}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>

                        <div className="grid grid-cols-3 gap-3">
                          <div className="space-y-2">
                            <Label className="text-xs font-medium text-muted-foreground">Quantity</Label>
                            <Input
                              type="number"
                              step={0.01}
                              min={0}
                              value={line.quantity}
                              onChange={(e) => handleLineChange(idx, "quantity", e.target.value)}
                              placeholder="1"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-medium text-muted-foreground">Unit cost (USD)</Label>
                            <Input
                              type="number"
                              step={0.01}
                              min={0}
                              value={line.unit_cost}
                              onChange={(e) => handleLineChange(idx, "unit_cost", e.target.value)}
                              placeholder="0.00"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-medium text-muted-foreground">Total</Label>
                            <div className="flex h-10 items-center rounded-md border border-input bg-background px-3 text-sm font-semibold">
                              ${lineTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>

                <Separator />

                <div className="rounded-lg border bg-muted/40 p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Subtotal</span>
                    <span className="text-lg font-semibold">${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">Before markup and tax</p>
                </div>
              </div>
            </div>
          </ScrollArea>

          {/* Footer */}
          <div className="flex-shrink-0 border-t bg-muted/30 p-4">
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="flex-1"
                disabled={loading}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={loading}
                className="flex-1"
              >
                {loading ? "Saving..." : "Create Proposal"}
              </Button>
            </div>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
