"use client"

import { useEffect, useState, useTransition } from "react"
import { addOptionConfigurationRuleAction, listOptionConfigurationRulesAction, removeOptionConfigurationRuleAction, searchConfigurationTargetsAction } from "@/app/(app)/design-studio/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Rule = { id: string; kind: "requires" | "excludes"; targetId: string; targetName: string }

export function OptionConfigurationRules({ optionId }: { optionId: string }) {
  const [rules, setRules] = useState<Rule[]>([])
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [targets, setTargets] = useState<Array<{ id: string; name: string }>>([])
  const [more, setMore] = useState(false)
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null)
  const [kind, setKind] = useState<"requires" | "excludes">("requires")
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    let active = true
    setEnabled(null)
    setError(null)
    listOptionConfigurationRulesAction(optionId).then((result) => {
      if (!active) return
      if (!result.success) { setError(result.error); return }
      setEnabled(result.data.enabled)
      setRules(result.data.rules)
    }).catch(() => { if (active) setError("Unable to load configuration rules") })
    return () => { active = false }
  }, [optionId, revision])

  useEffect(() => {
    if (!enabled || target) return
    let active = true
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const result = await searchConfigurationTargetsAction({ sourceId: optionId, search, page })
        if (!active) return
        if (!result.success) { setError(result.error); return }
        setTargets(result.data.items)
        setMore(result.data.more)
      } catch { if (active) setError("Unable to search options") }
      finally { if (active) setLoading(false) }
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [optionId, search, page, enabled, target])

  function mutate(ruleId?: string) {
    setError(null)
    startTransition(async () => {
      try {
        const result = ruleId ? await removeOptionConfigurationRuleAction({ sourceId: optionId, ruleId })
          : await addOptionConfigurationRuleAction({ sourceId: optionId, targetId: target?.id, kind })
        if (!result.success) { setError(result.error); return }
        setTarget(null)
        setRevision((value) => value + 1)
      } catch { setError("Unable to save configuration rules. Please retry.") }
    })
  }

  return <section className="space-y-3 border-t py-4" aria-label="Configuration rules">
    <div><h3 className="text-sm font-medium">Configuration rules</h3><p className="text-xs text-muted-foreground">Required options must be selected together. Incompatible options cannot share a home. Rule changes save immediately.</p></div>
    {error && <div role="alert" className="text-sm text-destructive">{error} <Button type="button" size="sm" variant="ghost" onClick={() => setRevision((value) => value + 1)}>Retry</Button></div>}
    {enabled === null && !error && <div className="h-10 animate-pulse bg-muted" aria-label="Loading rules" />}
    {enabled === false && <p className="text-sm text-muted-foreground">Configuration controls are awaiting deployment and organization activation.</p>}
    {enabled && <>
      {rules.length === 0 && <p className="text-sm text-muted-foreground">No rules for this option.</p>}
      {rules.map((rule) => <div key={rule.id} className="flex items-center justify-between gap-2 border px-3 py-2 text-sm"><span>{rule.kind === "requires" ? "Requires" : "Cannot combine with"} {rule.targetName}</span><Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => mutate(rule.id)}>Remove</Button></div>)}
      <Label htmlFor={`rule-kind-${optionId}`}>New rule</Label>
      <select id={`rule-kind-${optionId}`} value={kind} disabled={pending} onChange={(event) => setKind(event.target.value as "requires" | "excludes")} className="h-9 w-full border bg-background px-3 text-sm"><option value="requires">Requires option</option><option value="excludes">Cannot combine with option</option></select>
      {target ? <div className="flex items-center justify-between border p-2 text-sm"><span>{target.name}</span><Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setTarget(null)}>Change</Button></div> : <>
        <Label htmlFor={`rule-search-${optionId}`}>Find an option</Label>
        <Input id={`rule-search-${optionId}`} value={search} disabled={pending} maxLength={200} placeholder="Search option names" onChange={(event) => { setSearch(event.target.value); setPage(1); setTargets([]) }} />
        <div className="max-h-40 overflow-auto border" aria-busy={loading}>
          {loading ? <div className="h-10 animate-pulse bg-muted" /> : targets.map((item) => <button key={item.id} type="button" disabled={pending} onClick={() => setTarget(item)} className="block w-full border-b px-3 py-2 text-left text-sm hover:bg-muted">{item.name}</button>)}
          {!loading && targets.length === 0 && <p className="p-3 text-sm text-muted-foreground">No matching options</p>}
        </div>
        <div className="flex justify-between"><Button type="button" size="sm" variant="outline" disabled={pending || loading || page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button><Button type="button" size="sm" variant="outline" disabled={pending || loading || !more} onClick={() => setPage((value) => value + 1)}>Next</Button></div>
      </>}
      <Button type="button" size="sm" variant="outline" disabled={pending || !target} onClick={() => mutate()}>{pending ? "Saving…" : "Add rule"}</Button>
    </>}
  </section>
}
