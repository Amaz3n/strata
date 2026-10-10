"use client"

import { useEffect, useState, useTransition } from "react"
import { Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SearchPicker, type SearchPickerItem } from "@/components/ui/search-picker"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { WarrantyRoutingRule } from "@/lib/services/warranty/domain"
import { deleteWarrantyRoutingRuleAction, loadWarrantyRoutingEditorAction, saveWarrantyRoutingRuleAction, searchWarrantyCompaniesAction } from "./actions"

const ANY = "any"
const SEVERITY_LABEL = { emergency: "Emergency", routine_30: "30-day", routine_60: "60-day" } as const

/**
 * Who owns a new request, by rule. The lowest priority number among the rules a
 * request matches wins; an unset condition matches anything. Manual triage
 * stays available on every request — this only sets the starting owner.
 */
export function WarrantyRoutingRulesSheet({ open, onOpenChange, technicians }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  technicians: Array<{ id: string; name: string }>
}) {
  const [rules, setRules] = useState<WarrantyRoutingRule[]>([])
  const [communities, setCommunities] = useState<Array<{ id: string; name: string }>>([])
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle")
  const [loadError, setLoadError] = useState("")
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState("")
  const [priority, setPriority] = useState("100")
  const [severity, setSeverity] = useState(ANY)
  const [communityId, setCommunityId] = useState(ANY)
  const [category, setCategory] = useState("")
  const [assigneeKind, setAssigneeKind] = useState<"tech" | "trade">("tech")
  const [techId, setTechId] = useState("")
  const [company, setCompany] = useState<SearchPickerItem | null>(null)

  // The editor is a sheet, not part of the desk's first paint: read it when it opens.
  useEffect(() => {
    if (!open || loadState !== "idle") return
    setLoadState("loading")
    void loadWarrantyRoutingEditorAction().then((result) => {
      if (!result.success) { setLoadError(result.error); setLoadState("error"); return }
      setRules(result.data.rules)
      setCommunities(result.data.communities)
      setLoadState("ready")
    })
  }, [open, loadState])

  const communityName = (id: string | null) => communities.find((item) => item.id === id)?.name ?? "Any community"
  const ownerName = (rule: WarrantyRoutingRule) => rule.assignee_kind === "tech" ? technicians.find((item) => item.id === rule.assigned_user_id)?.name ?? "Technician" : "Trade"
  const ready = name.trim() && (assigneeKind === "tech" ? techId : company)

  const add = () => startTransition(async () => {
    const result = await saveWarrantyRoutingRuleAction({
      name: name.trim(), priority: Number(priority) || 0,
      severity: severity === ANY ? null : severity, category: category.trim() || null,
      community_id: communityId === ANY ? null : communityId,
      assignee_kind: assigneeKind,
      assigned_user_id: assigneeKind === "tech" ? techId : null,
      assigned_company_id: assigneeKind === "trade" ? company?.id ?? null : null,
    })
    if (!result.success) { toast.error(result.error); return }
    setRules((rows) => [...rows, result.data].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)))
    setName(""); setCategory(""); setSeverity(ANY); setCommunityId(ANY); setTechId(""); setCompany(null)
    toast.success("Routing rule saved")
  })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader><SheetTitle>Routing rules</SheetTitle></SheetHeader>
        <div className="space-y-5 p-4">
          <p className="text-xs text-muted-foreground">A new request goes to the first matching rule: lowest priority number, then the rule that says the most. Requests no rule matches wait in the queue for manual triage.</p>

          {loadState === "loading" || loadState === "idle" ? <div aria-busy="true" className="space-y-2">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-12 w-full" />)}</div> : null}
          {loadState === "error" ? <p role="alert" className="border border-border px-3 py-6 text-center text-sm text-destructive">{loadError || "Routing rules could not be loaded."}</p> : null}
          {loadState === "ready" ? <>
          <div className="divide-y divide-border border border-border">
            {rules.map((rule) => (
              <div key={rule.id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{rule.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {rule.severity ? SEVERITY_LABEL[rule.severity] : "Any severity"} · {communityName(rule.community_id)} · {rule.category ?? "Any category"} → {ownerName(rule)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="outline" className="tabular-nums">{rule.priority}</Badge>
                  <Button size="icon" variant="ghost" aria-label={`Delete ${rule.name}`} disabled={pending} onClick={() => startTransition(async () => {
                    const result = await deleteWarrantyRoutingRuleAction(rule.id)
                    if (!result.success) { toast.error(result.error); return }
                    setRules((rows) => rows.filter((row) => row.id !== rule.id))
                  })}><Trash2 className="size-4" /></Button>
                </div>
              </div>
            ))}
            {rules.length === 0 ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">No routing rules. Every request is triaged by hand.</p> : null}
          </div>

          <section className="space-y-3 border border-border p-3">
            <h3 className="text-sm font-semibold">Add a rule</h3>
            <div className="grid grid-cols-[1fr_6rem] gap-2">
              <div className="space-y-1.5"><Label htmlFor="rule-name">Name</Label><Input id="rule-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Emergencies in Palmetto Ridge" /></div>
              <div className="space-y-1.5"><Label htmlFor="rule-priority">Priority</Label><Input id="rule-priority" inputMode="numeric" className="tabular-nums" value={priority} onChange={(event) => setPriority(event.target.value.replace(/\D/g, ""))} /></div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger aria-label="Severity"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any severity</SelectItem>
                  {Object.entries(SEVERITY_LABEL).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={communityId} onValueChange={setCommunityId}>
                <SelectTrigger aria-label="Community"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any community</SelectItem>
                  {communities.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Input aria-label="Category" value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Category, e.g. HVAC (blank matches any)" />
            <div className="grid grid-cols-2 gap-2">
              <Select value={assigneeKind} onValueChange={(value) => { setAssigneeKind(value === "trade" ? "trade" : "tech"); setTechId(""); setCompany(null) }}>
                <SelectTrigger aria-label="Owner type"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="tech">In-house tech</SelectItem><SelectItem value="trade">Trade</SelectItem></SelectContent>
              </Select>
              {assigneeKind === "tech" ? (
                <Select value={techId} onValueChange={setTechId}>
                  <SelectTrigger aria-label="Technician"><SelectValue placeholder="Choose technician" /></SelectTrigger>
                  <SelectContent>{technicians.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
                </Select>
              ) : (
                <SearchPicker label="Trade" value={company} onChange={setCompany} search={searchWarrantyCompaniesAction} />
              )}
            </div>
            <Button disabled={pending || !ready} onClick={add}><Plus className="mr-2 size-4" />Add rule</Button>
          </section>
          </> : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
