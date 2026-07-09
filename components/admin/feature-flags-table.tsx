"use client"

import { useMemo, useState, useTransition } from "react"
import { Pencil, Plus, Settings, Trash2 } from "lucide-react"

import {
  createFeatureFlagAction,
  deleteFeatureFlagAction,
  toggleFeatureFlag,
  updateFeatureFlagAction,
} from "@/app/(app)/admin/features/actions"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import type { FeatureFlag, FeatureFlagOrganization } from "@/lib/services/admin"

import { unwrapAction } from "@/lib/action-result"

const FLAG_PRESETS = [
  {
    key: "billing_autopilot",
    label: "Arc Autopilot",
    description: "Experimental billing analysis and review workspace.",
    config: { experimental: true, mode: "review_only" },
  },
  {
    key: "ai_search_enabled",
    label: "AI Search",
    description: "Master switch for conversational AI search.",
    config: {},
  },
  {
    key: "ai_search_planner_v2",
    label: "AI Search Planner v2",
    description: "Enable the second-generation AI search planner.",
    config: {},
  },
  {
    key: "beta_features",
    label: "Beta Features",
    description: "General access to experimental Arc capabilities.",
    config: {},
  },
] as const

type FlagForm = {
  flagId?: string
  orgId: string
  flagKey: string
  enabled: boolean
  configText: string
  expiresAt: string
}

export function FeatureFlagsTable({
  initialFlags,
  organizations,
}: {
  initialFlags: FeatureFlag[]
  organizations: FeatureFlagOrganization[]
}) {
  const [flags, setFlags] = useState(initialFlags)
  const [form, setForm] = useState<FlagForm | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<FeatureFlag | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  const groupedFlags = useMemo(() => {
    const groups = new Map<string, { orgName: string; flags: FeatureFlag[] }>()
    for (const flag of flags) {
      const group = groups.get(flag.orgId) ?? { orgName: flag.orgName, flags: [] }
      group.flags.push(flag)
      groups.set(flag.orgId, group)
    }
    return Array.from(groups.entries())
      .map(([orgId, group]) => ({
        orgId,
        orgName: group.orgName,
        flags: group.flags.sort((a, b) => a.flagKey.localeCompare(b.flagKey)),
      }))
      .sort((a, b) => a.orgName.localeCompare(b.orgName))
  }, [flags])

  function openCreate(presetKey = "billing_autopilot") {
    const preset = FLAG_PRESETS.find((item) => item.key === presetKey) ?? FLAG_PRESETS[0]
    setForm({
      orgId: organizations[0]?.id ?? "",
      flagKey: preset.key,
      enabled: preset.key === "billing_autopilot" ? false : true,
      configText: JSON.stringify(preset.config, null, 2),
      expiresAt: "",
    })
  }

  function openEdit(flag: FeatureFlag) {
    setForm({
      flagId: flag.id,
      orgId: flag.orgId,
      flagKey: flag.flagKey,
      enabled: flag.enabled,
      configText: JSON.stringify(flag.config ?? {}, null, 2),
      expiresAt: toDateTimeLocal(flag.expiresAt),
    })
  }

  function applyPreset(key: string) {
    if (!form) return
    if (key === "__custom") {
      setForm({ ...form, flagKey: "", configText: "{}" })
      return
    }
    const preset = FLAG_PRESETS.find((item) => item.key === key)
    if (!preset) return
    setForm({
      ...form,
      flagKey: preset.key,
      configText: JSON.stringify(preset.config, null, 2),
    })
  }

  function saveFlag() {
    if (!form) return

    let config: Record<string, unknown>
    try {
      const parsed = JSON.parse(form.configText || "{}")
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("Configuration must be a JSON object.")
      }
      config = parsed
    } catch (error) {
      toast({
        title: "Invalid configuration",
        description: error instanceof Error ? error.message : "Enter valid JSON.",
        variant: "destructive",
      })
      return
    }

    setBusyKey(form.flagId ?? "create")
    startTransition(async () => {
      try {
        const input = {
          orgId: form.orgId,
          flagKey: form.flagKey.trim(),
          enabled: form.enabled,
          config,
          expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
        }

        if (form.flagId) {
          unwrapAction(await updateFeatureFlagAction({ ...input, flagId: form.flagId }))
          setFlags((current) =>
            current.map((flag) =>
              flag.id === form.flagId
                ? {
                    ...flag,
                    flagKey: input.flagKey,
                    enabled: input.enabled,
                    config,
                    expiresAt: input.expiresAt,
                  }
                : flag,
            ),
          )
          toast({ title: "Feature flag updated" })
        } else {
          const created = unwrapAction(await createFeatureFlagAction(input))
          setFlags((current) => [...current, created])
          toast({
            title: "Feature flag created",
            description: `${created.flagKey} is ${created.enabled ? "enabled" : "disabled"} for ${created.orgName}.`,
          })
        }
        setForm(null)
      } catch (error) {
        toast({
          title: "Unable to save feature flag",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        })
      } finally {
        setBusyKey(null)
      }
    })
  }

  function handleToggle(flag: FeatureFlag) {
    setBusyKey(flag.id)
    startTransition(async () => {
      try {
        unwrapAction(await toggleFeatureFlag(flag.id, flag.orgId, flag.flagKey, !flag.enabled))
        setFlags((current) =>
          current.map((item) => item.id === flag.id ? { ...item, enabled: !item.enabled } : item),
        )
        toast({
          title: "Feature flag updated",
          description: `${flag.flagKey} ${flag.enabled ? "disabled" : "enabled"} for ${flag.orgName}.`,
        })
      } catch (error) {
        toast({
          title: "Unable to update feature flag",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        })
      } finally {
        setBusyKey(null)
      }
    })
  }

  function handleDelete() {
    if (!deleteTarget) return
    setBusyKey(deleteTarget.id)
    startTransition(async () => {
      try {
        unwrapAction(await deleteFeatureFlagAction({ flagId: deleteTarget.id, orgId: deleteTarget.orgId }))
        setFlags((current) => current.filter((flag) => flag.id !== deleteTarget.id))
        toast({ title: "Feature flag deleted" })
        setDeleteTarget(null)
      } catch (error) {
        toast({
          title: "Unable to delete feature flag",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        })
      } finally {
        setBusyKey(null)
      }
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="font-medium">Organization feature controls</div>
          <p className="text-sm text-muted-foreground">
            Create experimental or staged capabilities, then enable them independently for each organization.
          </p>
        </div>
        <Button type="button" onClick={() => openCreate()} disabled={organizations.length === 0} className="gap-2">
          <Plus className="h-4 w-4" />
          Add feature flag
        </Button>
      </div>

      {groupedFlags.map(({ orgId, orgName, flags: orgFlags }) => (
        <Card key={orgId}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              {orgName}
            </CardTitle>
            <CardDescription>{orgFlags.length} configured feature {orgFlags.length === 1 ? "flag" : "flags"}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {orgFlags.map((flag) => (
              <div key={flag.id} className="flex flex-col gap-3 border p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-sm font-medium">{flag.flagKey}</code>
                    <Badge variant={flag.enabled ? "default" : "secondary"}>
                      {flag.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </div>
                  <div className="text-sm text-muted-foreground">{getFeatureDescription(flag.flagKey)}</div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>Config: {Object.keys(flag.config ?? {}).length ? JSON.stringify(flag.config) : "None"}</span>
                    {flag.expiresAt ? <span>Expires {new Date(flag.expiresAt).toLocaleString()}</span> : <span>No expiry</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={flag.enabled}
                    onCheckedChange={() => handleToggle(flag)}
                    disabled={isPending && busyKey === flag.id}
                    aria-label={`Toggle ${flag.flagKey}`}
                  />
                  <Button type="button" variant="outline" size="icon" onClick={() => openEdit(flag)} aria-label={`Edit ${flag.flagKey}`}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setDeleteTarget(flag)}
                    aria-label={`Delete ${flag.flagKey}`}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}

      {groupedFlags.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <Settings className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
            <h3 className="mb-2 text-lg font-medium">No feature flags configured</h3>
            <p className="mx-auto mb-4 max-w-md text-muted-foreground">
              Start with Arc Autopilot in disabled review mode, then enable it when you are ready to test.
            </p>
            <Button type="button" onClick={() => openCreate("billing_autopilot")} disabled={organizations.length === 0} className="gap-2">
              <Plus className="h-4 w-4" />
              Add Arc Autopilot
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Dialog open={Boolean(form)} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{form?.flagId ? "Edit feature flag" : "Add feature flag"}</DialogTitle>
            <DialogDescription>
              Flags are organization-scoped. Disabled flags remain configured without exposing the feature.
            </DialogDescription>
          </DialogHeader>

          {form ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="flag-org">Organization</Label>
                <Select
                  value={form.orgId}
                  onValueChange={(orgId) => setForm({ ...form, orgId })}
                  disabled={Boolean(form.flagId)}
                >
                  <SelectTrigger id="flag-org" className="w-full">
                    <SelectValue placeholder="Select organization" />
                  </SelectTrigger>
                  <SelectContent>
                    {organizations.map((org) => (
                      <SelectItem key={org.id} value={org.id}>
                        {org.name}{org.status !== "active" ? ` (${org.status})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {!form.flagId ? (
                <div className="space-y-2">
                  <Label>Preset</Label>
                  <Select value={FLAG_PRESETS.some((item) => item.key === form.flagKey) ? form.flagKey : "__custom"} onValueChange={applyPreset}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FLAG_PRESETS.map((preset) => (
                        <SelectItem key={preset.key} value={preset.key}>{preset.label}</SelectItem>
                      ))}
                      <SelectItem value="__custom">Custom flag</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              <div className="space-y-2">
                <Label htmlFor="flag-key">Flag key</Label>
                <Input
                  id="flag-key"
                  value={form.flagKey}
                  onChange={(event) => setForm({ ...form, flagKey: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
                  placeholder="billing_autopilot"
                />
                <p className="text-xs text-muted-foreground">Lowercase letters, numbers, and underscores only.</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="flag-config">Configuration JSON</Label>
                <Textarea
                  id="flag-config"
                  value={form.configText}
                  onChange={(event) => setForm({ ...form, configText: event.target.value })}
                  rows={7}
                  className="font-mono text-xs"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="flag-expiry">Expires at</Label>
                <Input
                  id="flag-expiry"
                  type="datetime-local"
                  value={form.expiresAt}
                  onChange={(event) => setForm({ ...form, expiresAt: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">Leave blank for no expiry.</p>
              </div>

              <div className="flex items-center justify-between border p-3">
                <div>
                  <Label htmlFor="flag-enabled">Enabled</Label>
                  <p className="text-xs text-muted-foreground">Make this capability available to the selected organization.</p>
                </div>
                <Switch
                  id="flag-enabled"
                  checked={form.enabled}
                  onCheckedChange={(enabled) => setForm({ ...form, enabled })}
                />
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setForm(null)} disabled={isPending}>Cancel</Button>
            <Button
              type="button"
              onClick={saveFlag}
              disabled={isPending || !form?.orgId || !form?.flagKey.trim()}
            >
              {isPending && (busyKey === "create" || busyKey === form?.flagId) ? "Saving..." : "Save feature flag"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete feature flag?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes <strong>{deleteTarget?.flagKey}</strong> from {deleteTarget?.orgName}. Features that default to disabled will disappear immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault()
                handleDelete()
              }}
              disabled={isPending}
            >
              {isPending && busyKey === deleteTarget?.id ? "Deleting..." : "Delete flag"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function getFeatureDescription(flagKey: string) {
  return FLAG_PRESETS.find((preset) => preset.key === flagKey)?.description ?? "Custom organization feature flag."
}

function toDateTimeLocal(value: string | null) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}
