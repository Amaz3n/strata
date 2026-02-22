"use client"

import { useState, useTransition } from "react"

import { clearPlatformAiDefaultsAction, updatePlatformAiDefaultsAction } from "@/app/(app)/platform/actions"
import { Sparkles } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

type AiProvider = "openai" | "anthropic" | "google"
type AiSource = "platform" | "env" | "default"

const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
}

const AI_PROVIDER_DEFAULT_MODELS: Record<AiProvider, string> = {
  openai: "gpt-4.1-mini",
  anthropic: "claude-3-5-sonnet-latest",
  google: "gemini-2.0-flash",
}

const AI_PROVIDER_PRESET_MODELS: Record<AiProvider, string[]> = {
  openai: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
  anthropic: ["claude-3-5-sonnet-latest", "claude-3-7-sonnet-latest", "claude-3-5-haiku-latest"],
  google: ["gemini-2.0-flash", "gemini-2.0-pro", "gemini-1.5-pro"],
}

function isAiProvider(value: string): value is AiProvider {
  return value === "openai" || value === "anthropic" || value === "google"
}

function sourceLabel(source: AiSource) {
  if (source === "platform") return "Arc override"
  if (source === "env") return "Environment default"
  return "Built-in default"
}

interface PlatformAiDefaultsCardProps {
  initialProvider: AiProvider
  initialModel: string
  initialSource: AiSource
  canManage: boolean
}

export function PlatformAiDefaultsCard({
  initialProvider,
  initialModel,
  initialSource,
  canManage,
}: PlatformAiDefaultsCardProps) {
  const [provider, setProvider] = useState<AiProvider>(initialProvider)
  const [model, setModel] = useState(initialModel)
  const [source, setSource] = useState<AiSource>(initialSource)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleProviderChange = (nextProvider: string) => {
    if (!isAiProvider(nextProvider)) return
    setProvider((prevProvider) => {
      const previousDefaultModel = AI_PROVIDER_DEFAULT_MODELS[prevProvider]
      const nextDefaultModel = AI_PROVIDER_DEFAULT_MODELS[nextProvider]
      const shouldResetModel = !model.trim() || model.trim() === previousDefaultModel
      if (shouldResetModel) {
        setModel(nextDefaultModel)
      }
      return nextProvider
    })
    setNotice(null)
    setError(null)
  }

  const handleSave = () => {
    if (!canManage || isPending) return
    setNotice(null)
    setError(null)

    startTransition(async () => {
      const result = await updatePlatformAiDefaultsAction({
        provider,
        model: model.trim(),
      })

      if (result?.error) {
        setError(result.error)
        return
      }

      setSource("platform")
      setModel(result?.model ?? model.trim())
      setNotice("Platform AI default updated for all orgs inheriting Arc defaults.")
    })
  }

  const handleResetToEnvironment = () => {
    if (!canManage || isPending) return
    setNotice(null)
    setError(null)

    startTransition(async () => {
      const result = await clearPlatformAiDefaultsAction()
      if (result?.error) {
        setError(result.error)
        return
      }

      if (result?.provider && isAiProvider(result.provider)) {
        setProvider(result.provider)
      }
      if (typeof result?.model === "string" && result.model.trim()) {
        setModel(result.model)
      }
      if (result?.source === "env" || result?.source === "default" || result?.source === "platform") {
        setSource(result.source)
      }

      setNotice("Platform override removed. Runtime defaults now come from environment/built-ins.")
    })
  }

  return (
    <div className="rounded-xl border border-border/70 bg-background/80 p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-500" />
            <h3 className="text-base font-semibold">Global AI Search Defaults</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Base provider/model for every org unless they set an org-specific override.
          </p>
        </div>
        <Badge variant="secondary" className="rounded-md">
          {sourceLabel(source)}
        </Badge>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[220px_1fr]">
        <div className="space-y-2">
          <Label htmlFor="platform-ai-provider" className="text-sm font-medium">
            Provider
          </Label>
          <Select value={provider} onValueChange={handleProviderChange} disabled={!canManage || isPending}>
            <SelectTrigger id="platform-ai-provider" className="h-11">
              <SelectValue placeholder="Select provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai">{AI_PROVIDER_LABELS.openai}</SelectItem>
              <SelectItem value="anthropic">{AI_PROVIDER_LABELS.anthropic}</SelectItem>
              <SelectItem value="google">{AI_PROVIDER_LABELS.google}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="platform-ai-model" className="text-sm font-medium">
            Model
          </Label>
          <Input
            id="platform-ai-model"
            value={model}
            onChange={(event) => {
              setModel(event.target.value)
              setNotice(null)
              setError(null)
            }}
            placeholder={AI_PROVIDER_DEFAULT_MODELS[provider]}
            className="h-11"
            disabled={!canManage || isPending}
          />
          <div className="flex flex-wrap gap-2">
            {AI_PROVIDER_PRESET_MODELS[provider].map((modelOption) => (
              <button
                key={modelOption}
                type="button"
                onClick={() => {
                  setModel(modelOption)
                  setNotice(null)
                  setError(null)
                }}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs transition-colors",
                  model === modelOption
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border/70 text-muted-foreground hover:border-border hover:text-foreground",
                )}
                disabled={!canManage || isPending}
              >
                {modelOption}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={!canManage || isPending}>
          {isPending ? "Saving..." : "Save global default"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleResetToEnvironment}
          disabled={!canManage || isPending || source !== "platform"}
        >
          Use environment defaults
        </Button>
        {!canManage && <span className="text-xs text-muted-foreground">Requires platform manage permissions.</span>}
      </div>

      {(error || notice) && (
        <div
          className={cn(
            "mt-4 rounded-md border px-3 py-2 text-sm",
            error ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-primary/30 bg-primary/5 text-primary",
          )}
        >
          {error ?? notice}
        </div>
      )}
    </div>
  )
}
