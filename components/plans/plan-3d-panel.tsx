"use client"

/**
 * The 3D model panel on the plan workbench.
 *
 * One panel per edition, with the honest status of its interpretation up
 * front: what was traced, how confident the trace is, what a human has fixed,
 * and whether buyers can see it yet. Review is the default surface, because
 * an unreviewed model is a claim rather than a fact — the walkthrough is one
 * click away and stays there.
 *
 * Three.js is behind a dynamic import in `plan-3d-viewer`, so opening a plan
 * that has no model costs nothing.
 */

import dynamic from "next/dynamic"
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  interpretFloorplanAction,
  correctFloorplanAction,
  loadFloorplanModelAction,
  publishFloorplanAction,
  unpublishFloorplanAction,
} from "@/app/(app)/floorplan/actions"
import { FloorplanReview } from "@/components/plans/floorplan-review"
import { AlertTriangle, Box, Loader2, RefreshCcw, Sparkles } from "@/components/icons"
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
import { unwrapAction } from "@/lib/action-result"
import {
  applyFloorplanEdit,
  modelConfidence,
  modelFloorAreaSqft,
  type FloorplanEdit,
  type FloorplanModel,
} from "@/lib/drawings/floorplan-model"
import type { FloorplanModelDto, FloorplanSheetView, FloorplanTarget } from "@/lib/services/floorplan-models"
import { cn } from "@/lib/utils"

const Plan3dViewer = dynamic(
  () => import("@/components/plans/plan-3d-viewer").then((module) => module.Plan3dViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading the viewer…
      </div>
    ),
  },
)

type Surface = "review" | "walk"

export interface Plan3dPanelProps {
  /** Which house this model belongs to — a plan edition, or a project. */
  target: FloorplanTarget
  /** Caption shown in the viewer, e.g. "2340 — The Ashford" or the address. */
  title: string
  /** Status only — the geometry is fetched on demand, it is far too big to ship. */
  status: FloorplanModelDto | null
  canWrite: boolean
  /** Plan id, so plan-surface writes revalidate the right pages. */
  planId?: string
  /**
   * Why there is nothing to interpret yet, when that is knowable up front.
   * Null means the source is ready and the button is live.
   */
  blockedReason?: string | null
}

export function Plan3dPanel({ target, title, status, canWrite, planId, blockedReason }: Plan3dPanelProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [record, setRecord] = useState<FloorplanModelDto | null>(status)
  const [model, setModel] = useState<FloorplanModel | null>(null)
  const [sheets, setSheets] = useState<FloorplanSheetView[]>([])
  const [loadingModel, setLoadingModel] = useState(false)
  const [surface, setSurface] = useState<Surface>("review")
  const [levelId, setLevelId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmReinterpret, setConfirmReinterpret] = useState(false)

  // A completed job only shows up if the panel notices the server's newer
  // status. `useState` ignores prop changes after mount, so sync explicitly —
  // on scalars, not on the object, which is a fresh identity every render.
  const statusKey = status ? `${status.status}:${status.updated_at}` : "none"
  useEffect(() => {
    setRecord(status)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusKey])

  /**
   * Fetch the geometry once per (target, revision) — and exactly once.
   *
   * The in-flight guard is a REF, not state. Held as state it also had to be a
   * dependency, so setting it re-ran the effect, whose cleanup cancelled the
   * fetch that had just been started: the request completed, saw `cancelled`,
   * and returned without ever clearing the spinner. The panel then sat on
   * "Loading the model" forever with perfectly good data on the wire.
   */
  const hasDocument = record?.status === "draft" || record?.status === "published"
  const documentKey = record ? `${record.id}:${record.updated_at}` : null
  const fetchedKeyRef = useRef<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  /**
   * Adopt a record this panel just wrote.
   *
   * Its `updated_at` moves, which is exactly what the fetch effect keys on — so
   * without claiming the new key, every correction would immediately re-download
   * the model the server just echoed back.
   */
  const adopt = useCallback((next: FloorplanModelDto) => {
    fetchedKeyRef.current = `${next.id}:${next.updated_at}`
    setRecord(next)
  }, [])

  useEffect(() => {
    if (!hasDocument || !documentKey) return
    if (fetchedKeyRef.current === documentKey) return
    fetchedKeyRef.current = documentKey
    let cancelled = false
    setLoadingModel(true)
    setLoadError(null)
    void (async () => {
      try {
        const loaded = unwrapAction(await loadFloorplanModelAction(target))
        if (cancelled) return
        setModel(loaded.record?.model ?? null)
        setSheets(loaded.sheets)
        setLevelId(loaded.record?.model?.levels[0]?.id ?? null)
      } catch (error) {
        if (cancelled) return
        // Never a silent forever-spinner: a failed load says so and offers a
        // retry, because the alternative is indistinguishable from a hang.
        setLoadError(error instanceof Error ? error.message : "Could not load the model")
      } finally {
        if (!cancelled) setLoadingModel(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [documentKey, hasDocument, target])

  // While the job is queued, the panel would otherwise sit on "Reading the
  // floorplan sheets" until someone reloaded by hand.
  useEffect(() => {
    if (record?.status !== "processing") return
    const id = window.setInterval(() => router.refresh(), 5000)
    return () => window.clearInterval(id)
  }, [record?.status, router])

  const levels = useMemo(() => model?.levels ?? [], [model])
  const level = levels.find((item) => item.id === levelId) ?? levels[0] ?? null
  const sheetByVersion = useMemo(
    () => new Map(sheets.map((sheet) => [sheet.sheetVersionId, sheet])),
    [sheets],
  )

  const queueInterpretation = useCallback(
    (force: boolean) => {
      startTransition(async () => {
        try {
          const next = unwrapAction(await interpretFloorplanAction(target, force, planId))
          setRecord(next)
          setModel(null)
          setSheets([])
          toast.success("Interpreting the plan sheets — this takes a minute")
          router.refresh()
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Could not start interpretation")
        }
      })
    },
    [planId, router, target],
  )

  /**
   * Apply a correction optimistically, then persist it.
   *
   * The same pure reducer runs on both sides, so the overlay never shows a
   * state the database will disagree with — and if the write fails, the local
   * model is rolled back rather than left ahead of the record.
   */
  const applyEdit = useCallback(
    (edit: FloorplanEdit) => {
      if (!model) return
      const next = applyFloorplanEdit(model, edit)
      if (next === model) return
      const previous = model
      setModel(next)
      setSaving(true)
      void (async () => {
        try {
          const saved = unwrapAction(await correctFloorplanAction(target, [edit], planId))
          adopt(saved)
          if (saved.model) setModel(saved.model)
        } catch (error) {
          setModel(previous)
          toast.error(error instanceof Error ? error.message : "Could not save the correction")
        } finally {
          setSaving(false)
        }
      })()
    },
    [adopt, model, planId, target],
  )

  const publish = useCallback(() => {
    startTransition(async () => {
      try {
        const next = unwrapAction(await publishFloorplanAction(target, planId))
        adopt(next)
        toast.success("3D model published")
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not publish the model")
      }
    })
  }, [adopt, planId, router, target])

  const unpublish = useCallback(() => {
    startTransition(async () => {
      try {
        const next = unwrapAction(await unpublishFloorplanAction(target, planId))
        adopt(next)
        toast.success("3D model unpublished")
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not unpublish the model")
      }
    })
  }, [adopt, planId, router, target])

  const confidence = model ? modelConfidence(model) : (record?.confidence ?? 0)
  const hasGeometry = !!model && model.levels.some((item) => item.walls.length > 0)

  return (
    <section id="plan-3d" className="border-t border-border">
      <header className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <Box className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">3D model</h2>
        </div>
        <StatusBadge record={record} />
        {record?.stale ? (
          <Badge variant="outline" className="gap-1 text-xs">
            <RefreshCcw className="h-3 w-3" />
            Newer interpretation available
          </Badge>
        ) : null}

        {hasGeometry ? (
          <p className="text-xs text-muted-foreground tabular-nums">
            {model!.levels.length} {model!.levels.length === 1 ? "level" : "levels"} ·{" "}
            {model!.levels.reduce((total, item) => total + item.rooms.length, 0)} rooms ·{" "}
            {modelFloorAreaSqft(model!).toLocaleString("en-US")} SF ·{" "}
            <span className={cn(confidence < 0.6 && "text-warning")}>{Math.round(confidence * 100)}% confidence</span>
            {record && record.correction_count > 0 ? ` · ${record.correction_count} corrections` : null}
          </p>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {hasGeometry ? (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant={surface === "review" ? "secondary" : "ghost"}
                onClick={() => setSurface("review")}
              >
                Review
              </Button>
              <Button size="sm" variant={surface === "walk" ? "secondary" : "ghost"} onClick={() => setSurface("walk")}>
                Walk through
              </Button>
            </div>
          ) : null}

          {canWrite ? (
            <>
              {!record || record.status === "failed" ? (
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={pending || !!blockedReason}
                  title={blockedReason ?? undefined}
                  onClick={() => queueInterpretation(false)}
                >
                  {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  Interpret sheets
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-1.5"
                  disabled={pending || record.status === "processing"}
                  onClick={() => {
                    if (record.correction_count > 0) setConfirmReinterpret(true)
                    else queueInterpretation(false)
                  }}
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                  Re-interpret
                </Button>
              )}
              {hasGeometry ? (
                record?.status === "published" ? (
                  <Button size="sm" variant="ghost" disabled={pending} onClick={unpublish}>
                    Unpublish
                  </Button>
                ) : (
                  <Button size="sm" disabled={pending} onClick={publish}>
                    Publish
                  </Button>
                )
              ) : null}
            </>
          ) : null}
        </div>
      </header>

      {model?.warnings?.length ? (
        <div className="flex items-start gap-2 border-t border-warning/40 bg-warning/10 px-4 py-2 sm:px-6">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <div className="text-xs text-foreground">
            <p className="font-medium">
              {model.warnings.length === 1 ? "A sheet was skipped" : `${model.warnings.length} sheets were skipped`}
            </p>
            <ul className="mt-0.5 space-y-0.5 text-muted-foreground">
              {model.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <div className="h-[560px] border-t border-border">
        {loadError && !model ? (
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5 text-warning" />}
            title="Could not load the model"
            body={loadError}
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  fetchedKeyRef.current = null
                  setLoadError(null)
                  setRecord((current) => (current ? { ...current } : current))
                }}
              >
                Try again
              </Button>
            }
          />
        ) : loadingModel && !model ? (
          <EmptyState
            icon={<Loader2 className="h-5 w-5 animate-spin" />}
            title="Loading the model"
            body="Reading the interpreted geometry for this edition."
          />
        ) : record?.status === "processing" ? (
          <EmptyState
            icon={<Loader2 className="h-5 w-5 animate-spin" />}
            title="Reading the floorplan sheets"
            body="Walls, doors and rooms are being traced from the plan set's vector linework. This usually finishes within a minute."
          />
        ) : record?.status === "failed" ? (
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5 text-warning" />}
            title="Interpretation did not produce a model"
            body={record.error ?? "Something went wrong reading the plan set."}
          />
        ) : !hasGeometry ? (
          <EmptyState
            icon={<Box className="h-5 w-5" />}
            title="No 3D model yet"
            body={
              blockedReason ??
              "Interpret the floorplan sheets to lift a walkable model out of them. Clients and superintendents can then walk the house in the browser."
            }
          />
        ) : surface === "walk" ? (
          <Plan3dViewer model={model!} caption={title} />
        ) : level ? (
          <div className="flex h-full flex-col">
            {levels.length > 1 ? (
              <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
                {levels.map((item) => (
                  <Button
                    key={item.id}
                    size="sm"
                    variant={item.id === level.id ? "secondary" : "ghost"}
                    onClick={() => setLevelId(item.id)}
                  >
                    {item.name}
                  </Button>
                ))}
              </div>
            ) : null}
            <div className="min-h-0 flex-1">
              <FloorplanReview
                level={level}
                sheet={sheetByVersion.get(level.source.sheetVersionId) ?? null}
                editable={canWrite}
                saving={saving}
                onEdit={applyEdit}
              />
            </div>
          </div>
        ) : null}
      </div>

      <AlertDialog open={confirmReinterpret} onOpenChange={setConfirmReinterpret}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Re-interpret and discard {record?.correction_count ?? 0}{" "}
              {record?.correction_count === 1 ? "correction" : "corrections"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Interpretation starts from the plan sheets again. Every wall deleted or drawn, every opening retyped and
              every room named by hand on this edition is lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the corrections</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmReinterpret(false)
                queueInterpretation(true)
              }}
            >
              Discard and re-interpret
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function StatusBadge({ record }: { record: FloorplanModelDto | null }) {
  if (!record) return <Badge variant="outline">Not interpreted</Badge>
  switch (record.status) {
    case "processing":
      return <Badge variant="secondary">Interpreting</Badge>
    case "draft":
      return <Badge variant="outline">Draft</Badge>
    case "published":
      return <Badge className="bg-success text-success-foreground">Published</Badge>
    case "failed":
      return <Badge variant="destructive">Failed</Badge>
  }
}

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode
  title: string
  body: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <div className="text-muted-foreground">{icon}</div>
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{body}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}
