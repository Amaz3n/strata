"use client"

import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import { clearPlatformAiDefaultsAction, setAiSearchAccessAction, updatePlatformAiDefaultsAction } from "@/app/(app)/platform/actions"
import { Sparkles, Search } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"

export type AiProvider = "openai" | "anthropic" | "google"
export type AiFeature = "search" | "document_extraction" | "drawings_vision"
export type AiSource = "platform" | "env" | "default"

export interface AiFeatureConfig {
  feature: AiFeature
  provider: AiProvider
  model: string
  source: AiSource
}

export interface OrgAiSearchAccess {
  orgId: string
  orgName: string
  enabled: boolean
}

const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
}

const FEATURE_META: Record<AiFeature, { title: string; description: string; providers: AiProvider[] }> = {
  search: {
    title: "Search Copilot",
    description: "Natural-language search, answers, and workflow planning.",
    providers: ["openai", "anthropic", "google"],
  },
  document_extraction: {
    title: "Expenses & Payables",
    description: "Receipt and vendor invoice extraction.",
    providers: ["google"],
  },
  drawings_vision: {
    title: "Drawings Vision",
    description: "OCR fallback for sheet number, title, and discipline.",
    providers: ["openai", "google"],
  },
}

const DEFAULT_MODELS: Record<AiFeature, Record<AiProvider, string>> = {
  search: { openai: "gpt-4.1-mini", anthropic: "claude-3-5-sonnet-latest", google: "gemini-2.0-flash" },
  document_extraction: { openai: "gpt-4.1-mini", anthropic: "claude-3-5-sonnet-latest", google: "gemini-2.5-flash-lite" },
  drawings_vision: { openai: "gpt-4.1-mini", anthropic: "claude-3-5-sonnet-latest", google: "gemini-2.5-flash-lite" },
}

const PRESET_MODELS: Record<AiFeature, Partial<Record<AiProvider, string[]>>> = {
  search: {
    openai: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
    anthropic: ["claude-3-5-sonnet-latest", "claude-3-7-sonnet-latest", "claude-3-5-haiku-latest"],
    google: ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"],
  },
  document_extraction: {
    google: ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"],
  },
  drawings_vision: {
    openai: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
    google: ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"],
  },
}

const SOURCE_LABELS: Record<AiSource, string> = {
  platform: "Arc override",
  env: "Environment",
  default: "Built-in",
}

function isAiProvider(value: string): value is AiProvider {
  return value === "openai" || value === "anthropic" || value === "google"
}

function normalizeConfigs(configs: AiFeatureConfig[]): AiFeatureConfig[] {
  const byFeature = new Map(configs.map((c) => [c.feature, c]))
  return (Object.keys(FEATURE_META) as AiFeature[]).map((feature) => {
    const fallbackProvider = FEATURE_META[feature].providers[0]
    return (
      byFeature.get(feature) ?? {
        feature,
        provider: fallbackProvider,
        model: DEFAULT_MODELS[feature][fallbackProvider],
        source: "default" as const,
      }
    )
  })
}

interface PlatformAiSheetProps {
  initialConfigs: AiFeatureConfig[]
  aiSearchAccess: OrgAiSearchAccess[]
  canManage: boolean
}

export function PlatformAiSheet({ initialConfigs, aiSearchAccess, canManage }: PlatformAiSheetProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant="outline" size="sm" className="h-8 rounded-none" onClick={() => setOpen(true)}>
        <Sparkles className="mr-1.5 h-3.5 w-3.5" />
        AI models
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          mobileFullscreen
          className="flex flex-col rounded-none p-0 shadow-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-xl sm:rounded-none"
        >
          <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-amber-500" />
              <SheetTitle>AI configuration</SheetTitle>
            </div>
            <SheetDescription>Model routing and per-org access for AI-powered surfaces.</SheetDescription>
          </SheetHeader>

          <Tabs defaultValue="routing" className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="border-b px-6 pt-4">
              <TabsList className="h-9 rounded-none bg-transparent p-0">
                <TabsTrigger
                  value="routing"
                  className="rounded-none border-b-2 border-transparent px-3 data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                >
                  Model routing
                </TabsTrigger>
                <TabsTrigger
                  value="access"
                  className="rounded-none border-b-2 border-transparent px-3 data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                >
                  Org access
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="routing" className="min-h-0 flex-1 overflow-y-auto px-6 py-5 data-[state=inactive]:hidden">
              <ModelRoutingTab initialConfigs={initialConfigs} canManage={canManage} />
            </TabsContent>
            <TabsContent value="access" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
              <OrgAccessTab orgs={aiSearchAccess} canManage={canManage} />
            </TabsContent>
          </Tabs>
        </SheetContent>
      </Sheet>
    </>
  )
}

function ModelRoutingTab({ initialConfigs, canManage }: { initialConfigs: AiFeatureConfig[]; canManage: boolean }) {
  const [configs, setConfigs] = useState(() => normalizeConfigs(initialConfigs))
  const [pendingFeature, setPendingFeature] = useState<AiFeature | null>(null)
  const [isPending, startTransition] = useTransition()

  const patch = (feature: AiFeature, next: Partial<AiFeatureConfig>) =>
    setConfigs((prev) => prev.map((c) => (c.feature === feature ? { ...c, ...next } : c)))

  const handleProviderChange = (feature: AiFeature, value: string) => {
    if (!isAiProvider(value)) return
    patch(feature, { provider: value, model: DEFAULT_MODELS[feature][value] })
  }

  const handleSave = (feature: AiFeature) => {
    if (!canManage || isPending) return
    const config = configs.find((c) => c.feature === feature)
    if (!config) return
    setPendingFeature(feature)
    startTransition(async () => {
      const result = await updatePlatformAiDefaultsAction({ feature, provider: config.provider, model: config.model.trim() })
      setPendingFeature(null)
      if (result?.error) {
        toast.error(result.error)
        return
      }
      patch(feature, { model: result?.model ?? config.model, provider: (result?.provider as AiProvider) ?? config.provider, source: "platform" })
      toast.success(`${FEATURE_META[feature].title} model saved`)
    })
  }

  const handleReset = (feature: AiFeature) => {
    if (!canManage || isPending) return
    setPendingFeature(feature)
    startTransition(async () => {
      const result = await clearPlatformAiDefaultsAction({ feature })
      setPendingFeature(null)
      if (result?.error) {
        toast.error(result.error)
        return
      }
      const provider = typeof result?.provider === "string" && isAiProvider(result.provider) ? result.provider : FEATURE_META[feature].providers[0]
      patch(feature, {
        provider,
        model: typeof result?.model === "string" ? result.model : DEFAULT_MODELS[feature][provider],
        source: result?.source === "env" || result?.source === "platform" ? result.source : "default",
      })
      toast.success(`${FEATURE_META[feature].title} reset to default`)
    })
  }

  return (
    <div className="space-y-1">
      {!canManage && (
        <p className="mb-4 text-xs text-muted-foreground">
          Read only — requires platform feature-flag permissions to change.
        </p>
      )}
      {configs.map((config, index) => {
        const meta = FEATURE_META[config.feature]
        const presets = PRESET_MODELS[config.feature][config.provider] ?? [DEFAULT_MODELS[config.feature][config.provider]]
        const modelOptions = Array.from(new Set([...presets, config.model].filter(Boolean)))
        const featurePending = isPending && pendingFeature === config.feature
        return (
          <div key={config.feature}>
            {index > 0 && <Separator className="my-5" />}
            <div className="flex items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold">{meta.title}</h4>
                <p className="text-xs text-muted-foreground">{meta.description}</p>
              </div>
              <Badge variant={config.source === "platform" ? "default" : "secondary"} className="shrink-0 rounded-none text-[11px]">
                {SOURCE_LABELS[config.source]}
              </Badge>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Provider</Label>
                <Select
                  value={config.provider}
                  onValueChange={(value) => handleProviderChange(config.feature, value)}
                  disabled={!canManage || isPending || meta.providers.length === 1}
                >
                  <SelectTrigger className="h-9 rounded-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {meta.providers.map((provider) => (
                      <SelectItem key={provider} value={provider}>
                        {PROVIDER_LABELS[provider]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Model</Label>
                <Select
                  value={config.model}
                  onValueChange={(value) => patch(config.feature, { model: value })}
                  disabled={!canManage || isPending}
                >
                  <SelectTrigger className="h-9 rounded-none font-mono text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.map((model) => (
                      <SelectItem key={model} value={model} className="font-mono text-xs">
                        {model}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" className="h-8 rounded-none" onClick={() => handleSave(config.feature)} disabled={!canManage || isPending}>
                {featurePending ? "Saving…" : "Save"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 rounded-none text-muted-foreground"
                onClick={() => handleReset(config.feature)}
                disabled={!canManage || isPending || config.source !== "platform"}
              >
                Reset to default
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function OrgAccessTab({ orgs: initialOrgs, canManage }: { orgs: OrgAiSearchAccess[]; canManage: boolean }) {
  const [orgs, setOrgs] = useState(initialOrgs)
  const [filter, setFilter] = useState("")
  const [pendingOrgId, setPendingOrgId] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const enabledCount = orgs.filter((o) => o.enabled).length
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return needle ? orgs.filter((o) => o.orgName.toLowerCase().includes(needle)) : orgs
  }, [orgs, filter])

  const handleToggle = (orgId: string, next: boolean) => {
    if (!canManage || pendingOrgId) return
    setPendingOrgId(orgId)
    setOrgs((prev) => prev.map((o) => (o.orgId === orgId ? { ...o, enabled: next } : o)))
    startTransition(async () => {
      const result = await setAiSearchAccessAction({ orgId, enabled: next })
      if (result?.error) {
        toast.error(result.error)
        setOrgs((prev) => prev.map((o) => (o.orgId === orgId ? { ...o, enabled: !next } : o)))
      }
      setPendingOrgId(null)
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-3 border-b px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Toggle the “Ask AI” command bar per org. Record search is unaffected.
          </p>
          <Badge variant="secondary" className="shrink-0 rounded-none text-[11px]">
            {enabledCount}/{orgs.length} on
          </Badge>
        </div>
        {orgs.length > 6 && (
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter organizations…"
              className="h-9 rounded-none pl-8"
            />
          </div>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="divide-y">
          {visible.map((org) => (
            <div key={org.orgId} className="flex items-center justify-between gap-3 px-6 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{org.orgName}</div>
                <div className="text-xs text-muted-foreground">{org.enabled ? "AI search enabled" : "AI search disabled"}</div>
              </div>
              <Switch
                checked={org.enabled}
                onCheckedChange={(checked) => handleToggle(org.orgId, checked)}
                disabled={!canManage || pendingOrgId === org.orgId}
              />
            </div>
          ))}
          {visible.length === 0 && (
            <p className="px-6 py-10 text-center text-sm text-muted-foreground">No organizations match that filter.</p>
          )}
        </div>
      </ScrollArea>

      {!canManage && (
        <p className="border-t px-6 py-3 text-xs text-muted-foreground">
          Requires platform feature-flag management permissions.
        </p>
      )}
    </div>
  )
}
