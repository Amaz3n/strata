"use client";

/**
 * The 3D model panel on the plan workbench.
 *
 * One panel per edition, with the honest status of its interpretation up
 * front: what was traced, how confident the trace is, what a human has fixed,
 * and whether buyers can see it yet. Review is the default surface, because
 * an unreviewed model is a claim rather than a fact — the walkthrough is one
 * click away and stays there.
 *
 * Three.js is imported when the model viewer mounts, so opening a plan
 * that has no model costs nothing.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  interpretFloorplanAction,
  correctFloorplanAction,
  loadFloorplanModelAction,
  publishFloorplanAction,
  unpublishFloorplanAction,
  restoreFloorplanDraftAction,
} from "@/app/(app)/floorplan/actions";
import { ModelPreparation } from "./model-preparation";
import { ModelHistory } from "./model-history";
import { ModelInspector } from "./model-inspector";
import type { ModelSourceSelection } from "@/lib/drawings/architectural-model";
import { validateArchitecturalModel } from "@/lib/drawings/architectural-validation";
import { FloorplanReview } from "@/components/plans/floorplan-review";
import { ModelStage } from "@/components/plans/model-viewer/model-stage";
import {
  AlertTriangle,
  Box,
  Loader2,
  RefreshCcw,
  Sparkles,
} from "@/components/icons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { unwrapAction } from "@/lib/action-result";
import {
  applyFloorplanEdit,
  modelFloorAreaSqft,
  type FloorplanEdit,
  type FloorplanModel,
} from "@/lib/drawings/floorplan-model";
import type {
  FloorplanModelDto,
  FloorplanSheetView,
  FloorplanTarget,
} from "@/lib/services/floorplan-models";
import { cn } from "@/lib/utils";


type Surface = "review" | "walk";

/**
 * How hard the panel watches a queued interpretation.
 *
 * `router.refresh()` re-runs the entire server tree and every query behind it,
 * so the wait is metered: interpretation usually lands inside a minute, and a
 * job still queued after that is not one more second of work away.
 */
const POLL_INITIAL_MS = 15_000;
const POLL_MAX_MS = 60_000;
const POLL_BACKOFF = 1.5;

export interface Plan3dPanelProps {
  /** Which house this model belongs to — a plan edition, or a project. */
  target: FloorplanTarget;
  /** Caption shown in the viewer, e.g. "2340 — The Ashford" or the address. */
  title: string;
  /** Status only — the geometry is fetched on demand, it is far too big to ship. */
  status: FloorplanModelDto | null;
  canWrite: boolean;
  /** Plan id, so plan-surface writes revalidate the right pages. */
  planId?: string;
  /**
   * Why there is nothing to interpret yet, when that is knowable up front.
   * Null means the source is ready and the button is live.
   */
  blockedReason?: string | null;
  /**
   * Fill the page instead of the workbench's fixed 560px band. The dedicated
   * model route is a viewer, not a panel — the model gets every pixel the
   * layout has.
   */
  fill?: boolean;
}

export function Plan3dPanel({
  target,
  title,
  status,
  canWrite,
  planId,
  blockedReason,
  fill = false,
}: Plan3dPanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [record, setRecord] = useState<FloorplanModelDto | null>(status);
  const [model, setModel] = useState<FloorplanModel | null>(null);
  const [sheets, setSheets] = useState<FloorplanSheetView[]>([]);
  const [loadingModel, setLoadingModel] = useState(false);
  const [surface, setSurface] = useState<Surface>("review");
  const [levelId, setLevelId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmReinterpret, setConfirmReinterpret] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const [history, setHistory] = useState<FloorplanModel[]>([]);
  const [future, setFuture] = useState<FloorplanModel[]>([]);
  const savingRef = useRef(false);
  const [retry, setRetry] = useState(0);
  const targetKey =
    target.kind === "project" ? target.projectId : target.housePlanVersionId;

  // A completed job only shows up if the panel notices the server's newer
  // status. `useState` ignores prop changes after mount, so sync explicitly —
  // on scalars, not on the object, which is a fresh identity every render.
  const statusKey = status ? `${status.status}:${status.updated_at}` : "none";
  useEffect(() => {
    setRecord(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusKey]);

  /**
   * Fetch the geometry once per (target, revision) — and exactly once.
   *
   * The in-flight guard is a REF, not state. Held as state it also had to be a
   * dependency, so setting it re-ran the effect, whose cleanup cancelled the
   * fetch that had just been started: the request completed, saw `cancelled`,
   * and returned without ever clearing the spinner. The panel then sat on
   * "Loading the model" forever with perfectly good data on the wire.
   */
  const hasDocument =
    !!record &&
    (record.level_count > 0 ||
      record.status === "draft" ||
      record.status === "published");
  const documentKey = record ? `${record.id}:${record.updated_at}` : null;
  const fetchedKeyRef = useRef<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * Adopt a record this panel just wrote.
   *
   * Its `updated_at` moves, which is exactly what the fetch effect keys on — so
   * without claiming the new key, every correction would immediately re-download
   * the model the server just echoed back.
   */
  const adopt = useCallback((next: FloorplanModelDto) => {
    fetchedKeyRef.current = `${next.id}:${next.updated_at}`;
    setRecord(next);
  }, []);

  useEffect(() => {
    if (!hasDocument || !documentKey) return;
    if (fetchedKeyRef.current === documentKey) return;
    fetchedKeyRef.current = documentKey;
    let cancelled = false;
    setLoadingModel(true);
    setLoadError(null);
    void (async () => {
      try {
        const loaded = unwrapAction(await loadFloorplanModelAction(target));
        if (cancelled) return;
        setModel(loaded.record?.model ?? null);
        setSheets(loaded.sheets);
        setLevelId(loaded.record?.model?.levels[0]?.id ?? null);
      } catch (error) {
        if (cancelled) return;
        // Never a silent forever-spinner: a failed load says so and offers a
        // retry, because the alternative is indistinguishable from a hang.
        setLoadError(
          error instanceof Error ? error.message : "Could not load the model",
        );
      } finally {
        if (!cancelled) setLoadingModel(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentKey, hasDocument, targetKey, retry]);

  /**
   * Watch a queued job until it lands — otherwise the panel would sit on
   * "Reading the floorplan sheets" until someone reloaded by hand.
   *
   * Only while `processing`: draft, published and failed are terminal, and the
   * status sync above tears this down the moment the job reaches one. Only
   * while the tab is in front of someone, so a forgotten background tab costs
   * the database nothing — and returning to it refreshes at once, which is the
   * moment the answer is most likely already waiting.
   */
  useEffect(() => {
    if (record?.status !== "processing") return;

    let timer: number | undefined;
    let delay = POLL_INITIAL_MS;

    const stop = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };

    const poll = () => {
      stop();
      router.refresh();
      delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_MS);
      timer = window.setTimeout(poll, delay);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") poll();
      else stop();
    };

    if (document.visibilityState === "visible")
      timer = window.setTimeout(poll, delay);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [record?.status, router]);

  const levels = useMemo(() => model?.levels ?? [], [model]);
  const level = levels.find((item) => item.id === levelId) ?? levels[0] ?? null;
  const sheetByVersion = useMemo(
    () => new Map(sheets.map((sheet) => [sheet.sheetVersionId, sheet])),
    [sheets],
  );

  const queueInterpretation = useCallback(
    (force: boolean, sources?: ModelSourceSelection[]) => {
      startTransition(async () => {
        try {
          const next = unwrapAction(
            await interpretFloorplanAction(target, force, planId, sources),
          );
          setRecord(next);
          setPreparing(false);
          setHistory([]);
          setFuture([]);
          toast.success(
            "Model generation started. Your published version stays available.",
          );
          router.refresh();
        } catch (error) {
          toast.error(
            error instanceof Error
              ? error.message
              : "Could not start interpretation",
          );
        }
      });
    },
    [planId, router, target],
  );

  /**
   * Apply a correction optimistically, then persist it.
   *
   * The same pure reducer runs on both sides, so the overlay never shows a
   * state the database will disagree with — and if the write fails, the local
   * model is rolled back rather than left ahead of the record.
   */
  const applyEdit = useCallback(
    (edit: FloorplanEdit) => {
      if (!model || savingRef.current || !record) return;
      const next = applyFloorplanEdit(model, edit);
      if (next === model) {
        toast.error(
          "This edit is not valid. Check dimensions, overlaps, and wall limits.",
        );
        return;
      }
      const errors = validateArchitecturalModel(next).filter(
        (issue) => issue.severity === "error",
      );
      const previousErrors = new Set(
        validateArchitecturalModel(model)
          .filter((issue) => issue.severity === "error")
          .map((issue) => issue.id),
      );
      const introduced = errors.find((issue) => !previousErrors.has(issue.id));
      if (
        introduced &&
        edit.type !== "wall.add" &&
        edit.type !== "wall.delete"
      ) {
        toast.error(introduced.message);
        return;
      }
      savingRef.current = true;
      const previous = model;
      setModel(next);
      setSaving(true);
      void (async () => {
        try {
          const saved = unwrapAction(
            await correctFloorplanAction(
              target,
              [edit],
              planId,
              record.updated_at,
            ),
          );
          adopt(saved);
          setHistory((items) => [...items, previous].slice(-50));
          setFuture([]);
          if (saved.model) setModel(saved.model);
        } catch (error) {
          setModel(previous);
          toast.error(
            error instanceof Error
              ? error.message
              : "Could not save the correction",
          );
        } finally {
          setSaving(false);
          savingRef.current = false;
        }
      })();
    },
    [adopt, model, planId, target, record],
  );

  const restore = useCallback(
    async (direction: "undo" | "redo") => {
      const stack = direction === "undo" ? history : future;
      const previous = stack.at(-1);
      if (!previous || !model || !record || savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      try {
        const saved = unwrapAction(
          await restoreFloorplanDraftAction(
            target,
            previous,
            record.updated_at,
            planId,
          ),
        );
        adopt(saved);
        setModel(saved.model);
        if (direction === "undo") {
          setHistory((h) => h.slice(0, -1));
          setFuture((h) => [...h, model]);
        } else {
          setFuture((h) => h.slice(0, -1));
          setHistory((h) => [...h, model]);
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not restore edit",
        );
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [adopt, future, history, model, planId, record, target],
  );

  const publish = useCallback(() => {
    startTransition(async () => {
      try {
        const next = unwrapAction(await publishFloorplanAction(target, planId));
        adopt(next);
        toast.success("3D model published");
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not publish the model",
        );
      }
    });
  }, [adopt, planId, router, target]);

  const unpublish = useCallback(() => {
    startTransition(async () => {
      try {
        const next = unwrapAction(
          await unpublishFloorplanAction(target, planId),
        );
        adopt(next);
        toast.success("3D model unpublished");
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not unpublish the model",
        );
      }
    });
  }, [adopt, planId, router, target]);

  const issues = model ? validateArchitecturalModel(model) : [];
  const hasGeometry = !!model && model.levels.length > 0;

  return (
    <section
      id="plan-3d"
      className={cn(
        "border-t border-border",
        fill && "flex min-h-0 flex-1 flex-col",
      )}
    >
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
            {model!.levels.length}{" "}
            {model!.levels.length === 1 ? "level" : "levels"} ·{" "}
            {model!.levels.reduce(
              (total, item) => total + item.rooms.length,
              0,
            )}{" "}
            rooms · {modelFloorAreaSqft(model!).toLocaleString("en-US")} SF ·{" "}
            <span>
              {issues.length
                ? `${issues.length} review items`
                : "Ready to present"}
            </span>
            {record && record.correction_count > 0
              ? ` · ${record.correction_count} corrections`
              : null}
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
                Floor plan
              </Button>
              <Button
                size="sm"
                variant={surface === "walk" ? "secondary" : "ghost"}
                onClick={() => setSurface("walk")}
              >
                3D studio
              </Button>
            </div>
          ) : null}

          {canWrite ? (
            <>
              {model && (
                <>
                  {record && (
                    <ModelHistory
                      target={target}
                      expectedUpdatedAt={record.updated_at}
                      planId={planId}
                      disabled={
                        saving || pending || record.status === "processing"
                      }
                      onRestore={(next) => {
                        setRecord(next);
                        setModel(next.model);
                        setHistory([]);
                        setFuture([]);
                        setSelection(null);
                        router.refresh();
                      }}
                    />
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={saving || !history.length}
                    onClick={() => void restore("undo")}
                  >
                    Undo
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={saving || !future.length}
                    onClick={() => void restore("redo")}
                  >
                    Redo
                  </Button>
                </>
              )}
              {!record || record.status === "failed" ? (
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={pending || !!blockedReason}
                  title={blockedReason ?? undefined}
                  onClick={() => setPreparing(true)}
                >
                  {pending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  Create from plans
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-1.5"
                  disabled={pending || record.status === "processing"}
                  onClick={() => {
                    if (record.correction_count > 0)
                      setConfirmReinterpret(true);
                    else setPreparing(true);
                  }}
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                  Sources
                </Button>
              )}
              {hasGeometry ? (
                record?.status === "published" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={unpublish}
                  >
                    Unpublish
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={
                      pending ||
                      saving ||
                      !!issues.length ||
                      record?.status === "processing"
                    }
                    onClick={publish}
                  >
                    Publish
                  </Button>
                )
              ) : null}
            </>
          ) : null}
        </div>
      </header>

      {record?.status === "failed" && model && (
        <p
          role="alert"
          className="border-t border-warning/40 bg-warning/10 px-4 py-2 text-sm"
        >
          {record.error ??
            "Generation failed. Your previous draft is preserved."}
        </p>
      )}
      {model?.warnings?.length ? (
        <div className="flex items-start gap-2 border-t border-warning/40 bg-warning/10 px-4 py-2 sm:px-6">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <div className="text-xs text-foreground">
            <p className="font-medium">Source review notes</p>
            <ul className="mt-0.5 space-y-0.5 text-muted-foreground">
              {model.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <div
        className={cn(
          "border-t border-border",
          fill ? "min-h-0 flex-1" : "h-[560px]",
        )}
      >
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
                  fetchedKeyRef.current = null;
                  setLoadError(null);
                  setRetry((value) => value + 1);
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
            title={`Generating model · ${record.generation_stage ?? "queued"}`}
            body="Preparing sources, recognizing architecture, reconciling spaces, and validating the editable model. The last published version remains available."
          />
        ) : record?.status === "failed" && !model ? (
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
        ) : level ? (
          <div className="flex h-full min-h-0 flex-col md:flex-row">
            <div className="flex min-h-[360px] min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
                {levels.map((item) => (
                  <Button
                    key={item.id}
                    size="sm"
                    variant={item.id === level.id ? "secondary" : "ghost"}
                    onClick={() => {
                      setLevelId(item.id);
                      setSelection(null);
                    }}
                  >
                    {item.name}
                  </Button>
                ))}
              </div>
              <div
                className={cn("min-h-0 flex-1", surface !== "walk" && "hidden")}
              >
                <ModelStage
                  model={model!}
                  title={title}
                  selected={selection}
                  onSelect={(pick) => {
                    if (pick) setLevelId(pick.levelId);
                    setSelection(pick?.id ?? null);
                  }}
                  onSaveView={(view) =>
                    applyEdit({ type: "view.save", levelId: level.id, view })
                  }
                />
              </div>
              <div
                className={cn(
                  "min-h-0 flex-1",
                  surface !== "review" && "hidden",
                )}
              >
                <FloorplanReview
                  level={level}
                  sheet={
                    sheetByVersion.get(level.source.sheetVersionId) ?? null
                  }
                  editable={canWrite && !saving}
                  saving={saving}
                  onEdit={applyEdit}
                  selection={selection}
                  onSelect={setSelection}
                />
              </div>
            </div>
            {canWrite && (
              <ModelInspector
                model={model!}
                level={level}
                selection={selection}
                onSelect={setSelection}
                onEdit={applyEdit}
                disabled={saving || pending}
              />
            )}
          </div>
        ) : null}
      </div>

      <ModelPreparation
        target={target}
        open={preparing}
        onClose={() => setPreparing(false)}
        onGenerate={(sources) => queueInterpretation(true, sources)}
        busy={pending}
      />
      <AlertDialog
        open={confirmReinterpret}
        onOpenChange={setConfirmReinterpret}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Re-interpret and discard {record?.correction_count ?? 0}{" "}
              {record?.correction_count === 1 ? "correction" : "corrections"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Generation starts from the source sheets again. Your existing
              draft is archived and the published model stays available. Every
              wall deleted or drawn, every opening retyped and every room named
              by hand on this edition is lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the corrections</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmReinterpret(false);
                setPreparing(true);
              }}
            >
              Discard and re-interpret
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function StatusBadge({ record }: { record: FloorplanModelDto | null }) {
  if (!record) return <Badge variant="outline">Not interpreted</Badge>;
  switch (record.status) {
    case "processing":
      return <Badge variant="secondary">Interpreting</Badge>;
    case "draft":
      return <Badge variant="outline">Draft</Badge>;
    case "published":
      return (
        <Badge className="bg-success text-success-foreground">Published</Badge>
      );
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
  }
}

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <div className="text-muted-foreground">{icon}</div>
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{body}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
