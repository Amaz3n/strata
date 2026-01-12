"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { createProposalAction } from "./proposal-actions"
import type { ProposalInput } from "@/lib/validation/proposals"
import type { Project } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const DEFAULT_LINE = { description: "", quantity: 1, unit_cost_cents: 0 }

export function ProposalBuilder({ projects }: { projects: Project[] }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "none")
  const [title, setTitle] = useState("")
  const [summary, setSummary] = useState("")
  const [terms, setTerms] = useState("")
  const [validUntil, setValidUntil] = useState("")
  const [markupPercent, setMarkupPercent] = useState<number | undefined>()
  const [taxRate, setTaxRate] = useState<number | undefined>()
  const [lines, setLines] = useState<Array<{ description: string; quantity: number; unit_cost_cents: number }>>([
    DEFAULT_LINE,
  ])

  const total = useMemo(() => {
    return lines.reduce((sum, line) => sum + (line.unit_cost_cents ?? 0) * (line.quantity ?? 1), 0)
  }, [lines])

  const handleLineChange = (idx: number, key: keyof (typeof lines)[number], value: string) => {
    setLines((prev) =>
      prev.map((line, i) =>
        i === idx
          ? {
              ...line,
              [key]: key === "description" ? value : Number(value) || 0,
            }
          : line,
      ),
    )
  }

  const addLine = () => setLines((prev) => [...prev, DEFAULT_LINE])
  const removeLine = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx))

  const handleSubmit = () => {
    if (!title.trim()) {
      toast.error("Title is required")
      return
    }
    const validLines = lines.filter((line) => line.description.trim())
    if (!validLines.length) {
      toast.error("Add at least one line")
      return
    }

    const resolvedProjectId = projectId === "none" ? undefined : projectId || undefined

    const payload: ProposalInput = {
      project_id: resolvedProjectId,
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

    startTransition(async () => {
      try {
        const { viewUrl } = await createProposalAction(payload)
        toast.success("Proposal created", { description: "Copy and share the recipient link." })
        router.push("/proposals")
        console.log("Proposal link:", viewUrl)
      } catch (error) {
        console.error(error)
        toast.error("Failed to create proposal", { description: (error as Error).message })
      }
    })
  }

  return (
    <div className="max-w-4xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Proposal details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Project</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No project yet</SelectItem>
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
            <Textarea value={terms} onChange={(e) => setTerms(e.target.value)} rows={5} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Line items</CardTitle>
          <Button variant="outline" size="sm" onClick={addLine}>
            Add line
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {lines.map((line, idx) => (
            <div key={idx} className="grid gap-3 sm:grid-cols-[2fr,1fr,1fr,auto] items-end">
              <div className="space-y-2">
                <Label>Description</Label>
                <Input
                  value={line.description}
                  onChange={(e) => handleLineChange(idx, "description", e.target.value)}
                  placeholder="Demo and haul debris"
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
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => removeLine(idx)} disabled={lines.length === 1}>
                  Remove
                </Button>
              </div>
            </div>
          ))}
          <Separator />
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Subtotal (before markup/tax)</span>
            <span className="text-lg font-semibold">${(total / 100).toLocaleString()}</span>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={() => router.push("/proposals")}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={isPending}>
          {isPending ? "Saving..." : "Create proposal"}
        </Button>
      </div>
    </div>
  )
}
