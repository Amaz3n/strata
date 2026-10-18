"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  correctFloorplanAction,
  interpretFloorplanAction,
  loadFloorplanModelAction,
  loadFloorplanModelStatusAction,
  publishFloorplanAction,
} from "@/app/(app)/floorplan/actions";
import { unwrapAction } from "@/lib/action-result";
import type { ModelSourceSelection } from "@/lib/drawings/architectural-model";
import { validateArchitecturalModel } from "@/lib/drawings/architectural-validation";
import { applyFloorplanEdit, type FloorplanEdit, type FloorplanModel } from "@/lib/drawings/floorplan-model";
import type { FloorplanModelDto, FloorplanSheetView, FloorplanTarget } from "@/lib/services/floorplan-models";

/**
 * Where a model is in its life, as the workspace shows it:
 * `none` — never traced; `generating` — a job is running; `failed` — the last
 * job failed and there is nothing to show; `ready` — a model to look at.
 */
export type ModelPhase = "loading" | "none" | "generating" | "failed" | "ready" | "error";

/** The interpreter's stages, in order, as the progress list reads them. */
export const GENERATION_STAGES: Array<{ key: string; label: string }> = [
  { key: "queued", label: "Queued" },
  { key: "preparing", label: "Reading the sheets" },
  { key: "recognizing", label: "Finding walls, doors and windows" },
  { key: "reconciling", label: "Stacking the floors" },
  { key: "validating", label: "Checking the model" },
];

const POLL_FIRST_MS = 2500;
const POLL_MAX_MS = 15000;

export function useWorkspaceModel(target: FloorplanTarget | null, enabled: boolean) {
  const [record, setRecord] = useState<FloorplanModelDto | null>(null);
  const [model, setModel] = useState<FloorplanModel | null>(null);
  const [sheets, setSheets] = useState<FloorplanSheetView[]>([]);
  const [phase, setPhase] = useState<ModelPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const savingRef = useRef(false);
  const targetKey = target ? (target.kind === "project" ? `p:${target.projectId}` : `v:${target.housePlanVersionId}`) : null;
  const targetRef = useRef(target);
  targetRef.current = target;

  const settle = useCallback((next: FloorplanModelDto | null, nextModel: FloorplanModel | null) => {
    setRecord(next);
    setModel(nextModel);
    setPhase(
      !next
        ? "none"
        : next.status === "processing"
          ? "generating"
          : nextModel
            ? "ready"
            : next.status === "failed"
              ? "failed"
              : "none",
    );
  }, []);

  const loadFull = useCallback(async () => {
    const current = targetRef.current;
    if (!current) return;
    setError(null);
    try {
      const loaded = unwrapAction(await loadFloorplanModelAction(current));
      setSheets(loaded.sheets);
      settle(loaded.record, loaded.record?.model ?? null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't load the 3D model");
      setPhase("error");
    }
  }, [settle]);

  useEffect(() => {
    if (!enabled || !targetKey) return;
    setPhase("loading");
    void loadFull();
  }, [enabled, targetKey, loadFull]);

  // While a job runs, poll the status (never the geometry) with a gentle
  // backoff, only while the tab is visible; load the model when it lands.
  const status = record?.status;
  useEffect(() => {
    if (!enabled || status !== "processing") return;
    let timer: number | undefined;
    let delay = POLL_FIRST_MS;
    let cancelled = false;
    const poll = async () => {
      const current = targetRef.current;
      if (!current || cancelled) return;
      try {
        const next = unwrapAction(await loadFloorplanModelStatusAction(current));
        if (cancelled) return;
        if (next && next.status !== "processing") {
          await loadFull();
          if (next.status === "failed") toast.error(next.error ?? "The model couldn't be built from these sheets");
          else toast.success("The 3D model is ready");
          return;
        }
        setRecord((previous) => (next && previous ? { ...previous, generation_stage: next.generation_stage, updated_at: next.updated_at } : previous));
      } catch {
        // A failed poll is retried on the next tick; the stage just doesn't move.
      }
      delay = Math.min(delay * 1.5, POLL_MAX_MS);
      if (!cancelled && document.visibilityState === "visible") timer = window.setTimeout(poll, delay);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        window.clearTimeout(timer);
        void poll();
      } else window.clearTimeout(timer);
    };
    timer = window.setTimeout(poll, delay);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, status, loadFull]);

  const generate = useCallback(
    async (options: { force: boolean; sources?: ModelSourceSelection[] }) => {
      const current = targetRef.current;
      if (!current) return false;
      setStarting(true);
      try {
        const next = unwrapAction(await interpretFloorplanAction(current, options.force, undefined, options.sources));
        setRecord(next);
        setPhase("generating");
        return true;
      } catch (failure) {
        toast.error(failure instanceof Error ? failure.message : "Couldn't start building the model");
        return false;
      } finally {
        setStarting(false);
      }
    },
    [],
  );

  /**
   * Apply an edit optimistically, then persist it. The same pure reducer runs
   * on both sides, so the screen never shows a state the database disagrees
   * with; a failed write rolls the local model back.
   */
  const applyEdit = useCallback(
    async (change: FloorplanEdit | FloorplanEdit[]): Promise<boolean> => {
      const current = targetRef.current;
      if (!current || !model || !record || savingRef.current) return false;
      const edits = Array.isArray(change) ? change : [change];
      const next = edits.reduce(applyFloorplanEdit, model);
      if (next === model) {
        toast.error("That change doesn't fit the model. Check its size and position.");
        return false;
      }
      const before = new Set(validateArchitecturalModel(model).filter((issue) => issue.severity === "error").map((issue) => issue.id));
      const introduced = validateArchitecturalModel(next).find((issue) => issue.severity === "error" && !before.has(issue.id));
      if (introduced && !edits.some((edit) => edit.type === "wall.add" || edit.type === "wall.delete")) {
        toast.error(introduced.message);
        return false;
      }
      savingRef.current = true;
      setSaving(true);
      const previous = model;
      setModel(next);
      try {
        const saved = unwrapAction(await correctFloorplanAction(current, edits, undefined, record.updated_at));
        setRecord(saved);
        if (saved.model) setModel(saved.model);
        return true;
      } catch (failure) {
        setModel(previous);
        toast.error(failure instanceof Error ? failure.message : "Couldn't save that change");
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [model, record],
  );

  const publish = useCallback(async () => {
    const current = targetRef.current;
    if (!current) return;
    try {
      const next = unwrapAction(await publishFloorplanAction(current));
      setRecord(next);
      toast.success("Published to the client portal");
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't publish the model");
    }
  }, []);

  return { record, model, sheets, phase, error, saving, starting, generate, applyEdit, publish, reload: loadFull };
}
