"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  acceptTakeoffAreasAction,
  proposeTakeoffAreasAction,
  exportAreaDetectionReplayAction,
} from "@/app/(app)/drawings/takeoff-actions";
import {
  AREA_ENGINE_VERSION,
  containsPoint,
  mergeAreas,
  proposalArea,
  splitArea,
  validRing,
  validateAreaGeometry,
  type AreaFinishPolicy,
  type AreaDetection,
  type AreaBoundary,
  type AreaProposal,
  type AreaRegion,
} from "@/lib/drawings/area-takeoff";
import { areaReviewDraftSchema } from "@/lib/drawings/area-review-draft";
import { reconcileAreaProposals } from "@/lib/drawings/area-review";
import {
  assessAreaCoverage,
  type AreaCoverage,
} from "@/lib/drawings/area-coverage";
import type { AreaPoint } from "@/lib/drawings/area-evidence";

import type { TakeoffCondition } from "@/lib/services/takeoff";

export type AreaEditTool =
  | "select"
  | "region"
  | "boundary"
  | "split"
  | "corner"
  | "edge"
  | "deduct";
export function useAreaTakeoff(options: {
  sheetVersionId: string | null;
  conditionId: string | null;
  scale: number | null;
  imageSize: { width: number; height: number } | null;
  allowed: boolean;
  onSaved: () => void;
  scopeKey?: string;
  sourceKey?: string;
  canAccept?: boolean;
}) {
  const identity = `${AREA_ENGINE_VERSION}|${options.scopeKey ?? ""}|${options.sheetVersionId}|${options.sourceKey ?? ""}|${options.scale}|${options.imageSize?.width}|${options.imageSize?.height}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [open, setOpen] = useState(false);
  const activeIdentity = useRef(identity);
  const [tool, setTool] = useState<AreaEditTool>("select");
  const [region, setRegion] = useState<AreaRegion | null>(null);
  const [pending, setPending] = useState<AreaPoint | null>(null);
  const [boundaries, setBoundaries] = useState<AreaBoundary[]>([]);
  const [proposals, setProposals] = useState<AreaProposal[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"detecting" | "saving" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<AreaDetection["diagnostic"]>();
  const [exportingDiagnostic, setExportingDiagnostic] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [finishScopeNote, setFinishScopeNote] = useState("");
  const [finishPolicy, setFinishPolicy] = useState<AreaFinishPolicy>("drawn");
  const [coverage, setCoverage] = useState<AreaCoverage | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [scaleConfirmed, setScaleConfirmed] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [assigned, setAssigned] = useState<Record<string, string[]>>({});
  const [restored, setRestored] = useState(false);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const signature = (area: AreaProposal) =>
    JSON.stringify([area.points, area.holes]);
  const storageKey = `arc:area-review:2:${identity}`;
  const imageWidth = options.imageSize?.width ?? 0;
  const imageHeight = options.imageSize?.height ?? 0;
  const currentScale = options.scale ?? 0;
  const draftReady =
    options.allowed &&
    !!options.sheetVersionId &&
    !!options.scale &&
    !!options.imageSize;
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);
  const [history, setHistory] = useState<AreaProposal[][]>([]);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const request = useRef(0),
    started = useRef(0),
    mounted = useRef(true),
    lock = useRef(false);
  const close = useCallback(() => {
    if (busyRef.current === "saving") return;
    request.current++;
    setOpen(false);
    setPending(null);
    setBusy(null);
    lock.current = false;
  }, []);
  // Drafts belong to the drawing revision/scale, never to the selected item.
  // sessionStorage survives viewer remounts and reloads without sharing drafts across tabs.
  useEffect(() => {
    busyRef.current = null;
    close();
    activeIdentity.current = identity;
    setLoadedIdentity(null);
    setFinishScopeNote("");
    setFinishPolicy("drawn");
    setCoverage(null);
    setDiagnostic(undefined);
    setRegion(null);
    setProposals([]);
    setSelected(new Set());
    setBoundaries([]);
    setHistory([]);
    setReviewed(false);
    setScaleConfirmed(false);
    setAssigned({});
    setHoveredId(null);
    setRestored(false);
    setError(null);
    setStorageWarning(null);
    setWarnings([]);
    if (!draftReady) return;
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const draft = areaReviewDraftSchema.parse(JSON.parse(raw));
        setProposals(
          draft.proposals.map((area) => ({
            ...area,
            areaSqft: proposalArea(area, imageWidth, imageHeight, currentScale),
          })),
        );
        setRegion(draft.region);
        setBoundaries(draft.boundaries ?? []);
        setFinishPolicy(
          draft.finishPolicy === "include-fixtures"
            ? "include-fixtures"
            : "drawn",
        );
        setWarnings(draft.warnings ?? []);
        setCoverage(draft.coverage ?? null);
        setAssigned(draft.assigned ?? {});
        setSelected(new Set(draft.selected ?? []));
        setRestored(draft.proposals.length > 0);
        setFinishScopeNote(draft.finishScopeNote ?? "");
      }
    } catch {
      setStorageWarning(
        "The saved review could not be restored. Find areas to start again.",
      );
    }
    setLoadedIdentity(identity);
  }, [
    identity,
    draftReady,
    close,
    storageKey,
    imageWidth,
    imageHeight,
    currentScale,
  ]);
  useEffect(() => {
    if (loadedIdentity !== identity || !options.allowed) return;
    try {
      if (!proposals.length && !region && !boundaries.length) {
        sessionStorage.removeItem(storageKey);
        return;
      }
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 2,
          proposals,
          region,
          boundaries,
          finishPolicy,
          warnings,
          coverage,
          assigned,
          selected: [...selected],
          finishScopeNote,
        }),
      );
      // Keep recovery bounded when traversing large drawing sets.
      const keys = Object.keys(sessionStorage).filter(
        (key) => key.startsWith("arc:area-review:2:") && key !== storageKey,
      );
      for (const key of keys.slice(0, Math.max(0, keys.length - 19)))
        sessionStorage.removeItem(key);
    } catch {
      setStorageWarning(
        "Draft recovery is unavailable in this browser. Keep this viewer open until you add your areas.",
      );
    }
  }, [
    identity,
    loadedIdentity,
    storageKey,
    options.allowed,
    proposals,
    region,
    boundaries,
    finishPolicy,
    warnings,
    coverage,
    assigned,
    selected,
    finishScopeNote,
  ]);
  useEffect(() => {
    setReviewed(false);
    setFinishScopeNote("");
  }, [options.conditionId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, []);
  const visible =
    open && activeIdentity.current === identity && options.allowed;
  const activate = () => {
    activeIdentity.current = identity;
    setOpen(true);
    setTool("select");
    setError(null);
    started.current = Date.now();
    if (!proposals.length && options.scale) void detect();
  };
  const changeTool = (next: AreaEditTool) => {
    if (lock.current) return;
    setTool(next);
    setPending(null);
    setError(null);
  };
  const replace = (next: AreaProposal[]) => {
    setHistory((h) => [...h.slice(-19), proposals]);
    setProposals(next);
    setSelected(
      (ids) => new Set(next.filter((p) => ids.has(p.id)).map((p) => p.id)),
    );
    setReviewed(false);
  };
  const recalculate = (area: AreaProposal): AreaProposal => ({
    ...area,
    areaSqft:
      options.imageSize && options.scale
        ? proposalArea(
            area,
            options.imageSize.width,
            options.imageSize.height,
            options.scale,
          )
        : 0,
  });
  const detect = async (
    vision = false,
    nextBoundaries = boundaries,
    policy = finishPolicy,
    resetEdits = false,
  ) => {
    if (
      !options.allowed ||
      !options.sheetVersionId ||
      !options.scale ||
      lock.current
    )
      return;
    const token = ++request.current,
      capturedIdentity = identity;
    lock.current = true;
    setBusy("detecting");
    setError(null);
    setReviewed(false);
    try {
      const result = await proposeTakeoffAreasAction({
        sheet_version_id: options.sheetVersionId,
        region: region ?? undefined,
        boundaries: nextBoundaries,
        vision,
        finish_policy: policy,
      });
      if (
        !mounted.current ||
        request.current !== token ||
        identityRef.current !== capturedIdentity
      )
        return;
      if (!result.success) throw new Error(result.error);
      if (result.data.scale !== options.scale)
        throw new Error(
          "Scale changed. Reopen this drawing before detecting areas.",
        );
      setDiagnostic(result.data.diagnostic);
      setCoverage(result.data.coverage ?? null);
      const next = reconcileAreaProposals(
        resetEdits ? [] : proposals,
        result.data.proposals,
      );
      setHistory((h) => (resetEdits ? [] : [...h.slice(-19), proposals]));
      setProposals(next.proposals);
      setSelected(new Set());
      setWarnings([
        ...result.data.warnings,
        ...(next.preserved
          ? [
              `Kept ${next.preserved} edited areas; ${next.suppressed} overlapping new proposals were excluded. Undo to return to the previous detection.`,
            ]
          : []),
      ]);
      setTool("select");
    } catch (e) {
      if (mounted.current && request.current === token)
        setError(e instanceof Error ? e.message : "Detection failed");
    } finally {
      if (mounted.current && request.current === token) {
        lock.current = false;
        busyRef.current = null;
        setBusy(null);
      }
    }
  };
  // Geometry belongs to the sheet and can be reused for different finishes.
  const availableProposals = proposals;
  const isAssignedTo = (area: AreaProposal, conditionId: string) =>
    (assigned[conditionId] ?? []).includes(signature(area));
  const selectedAreas = availableProposals.filter((p) => selected.has(p.id));
  const toggle = (id: string) => {
    if (busy) return;
    setSelected((ids) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setReviewed(false);
  };
  const click = (point: AreaPoint) => {
    if (!visible || busy) return;
    setError(null);
    if (tool === "select") {
      const hit = [...availableProposals]
        .sort((a, b) => a.areaSqft - b.areaSqft)
        .find(
          (p) =>
            containsPoint(point, p.points) &&
            !p.holes.some((h) => containsPoint(point, h)),
        );
      if (hit) toggle(hit.id);
      return;
    }
    if (
      tool !== "region" &&
      tool !== "boundary" &&
      selectedAreas.length !== 1
    ) {
      setError("Select exactly one area before editing it.");
      return;
    }
    if (!pending) {
      setPending(point);
      return;
    }
    const first = pending;
    setPending(null);
    try {
      if (tool === "region") {
        if (
          Math.abs(first[0] - point[0]) < 0.001 ||
          Math.abs(first[1] - point[1]) < 0.001
        )
          throw new Error("Choose opposite corners of the plan region.");
        setRegion({
          x0: Math.min(first[0], point[0]),
          y0: Math.min(first[1], point[1]),
          x1: Math.max(first[0], point[0]),
          y1: Math.max(first[1], point[1]),
        });
        setCoverage(null);
        setProposals([]);
        setBoundaries([]);
        setSelected(new Set());
        setHistory([]);
        setScaleConfirmed(false);
        setReviewed(false);
        setTool("select");
      } else if (tool === "boundary") {
        const next = [
          ...boundaries,
          { a: first, b: point, source: "user" as const },
        ];
        setBoundaries(next);
        void detect(false, next);
      } else {
        const area = selectedAreas[0];
        if (tool === "split") {
          replace(
            proposals.flatMap((p) =>
              p.id === area.id
                ? splitArea(area, first, point).map(recalculate)
                : [p],
            ),
          );
          return;
        }
        let changed = { ...area, edited: true };
        if (tool === "deduct") {
          const x0 = Math.min(first[0], point[0]),
            x1 = Math.max(first[0], point[0]),
            y0 = Math.min(first[1], point[1]),
            y1 = Math.max(first[1], point[1]);
          const hole: AreaPoint[] = [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1],
          ];
          if (
            !validRing(hole) ||
            !hole.every((p) => containsPoint(p, area.points))
          )
            throw new Error(
              "Draw the deduction entirely inside the selected area.",
            );
          changed = { ...changed, holes: [...area.holes, hole] };
        } else {
          const size = options.imageSize ?? { width: 1, height: 1 };
          const distance = (a: AreaPoint, b: AreaPoint) =>
            Math.hypot((a[0] - b[0]) * size.width, (a[1] - b[1]) * size.height);
          let nearest = 0,
            nearestDistance = Infinity;
          area.points.forEach((p, i) => {
            const q = area.points[(i + 1) % area.points.length];
            const target: AreaPoint =
              tool === "edge" ? [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] : p;
            const d = distance(first, target);
            if (d < nearestDistance) {
              nearest = i;
              nearestDistance = d;
            }
          });
          if (nearestDistance > Math.max(size.width, size.height) * 0.03)
            throw new Error(
              tool === "edge"
                ? "Click near the midpoint of an edge first."
                : "Click near a corner first.",
            );
          const points = area.points.map((p): AreaPoint => [...p]);
          if (tool === "corner") points[nearest] = point;
          else {
            const next = (nearest + 1) % points.length;
            const middle: AreaPoint = [
              (points[nearest][0] + points[next][0]) / 2,
              (points[nearest][1] + points[next][1]) / 2,
            ];
            for (const i of [nearest, next])
              points[i] = [
                points[i][0] + point[0] - middle[0],
                points[i][1] + point[1] - middle[1],
              ];
          }
          if (
            !validRing(points) ||
            points.some((p) => p.some((n) => n < 0 || n > 1))
          )
            throw new Error("That edit would create an invalid boundary.");
          changed = { ...changed, points };
        }
        validateAreaGeometry(changed);
        replace(
          proposals.map((p) => (p.id === area.id ? recalculate(changed) : p)),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to edit area");
    }
  };
  const merge = () => {
    if (lock.current) return;
    try {
      const merged = recalculate(mergeAreas(selectedAreas));
      replace([...proposals.filter((p) => !selected.has(p.id)), merged]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to merge areas");
    }
  };
  const accept = async (destination?: TakeoffCondition): Promise<boolean> => {
    const conditionId = destination?.id ?? options.conditionId;
    const compatible = destination
      ? (destination.uom === "sf" || destination.uom === "sy") &&
        !destination.height_ft &&
        !destination.pitch_rise
      : options.canAccept !== false;
    if (
      !mounted.current ||
      identityRef.current !== identity ||
      !options.allowed ||
      !compatible ||
      !selectedAreas.length ||
      selectedAreas.length > 50 ||
      !reviewed ||
      !scaleConfirmed ||
      !options.sheetVersionId ||
      !conditionId ||
      !options.scale ||
      lock.current
    )
      return false;
    if (
      selectedAreas.some((area) =>
        (assigned[conditionId] ?? []).includes(signature(area)),
      )
    ) {
      setError(
        "Some selected areas are already saved to this quantity. Choose another quantity or remove those areas.",
      );
      return false;
    }
    const token = ++request.current,
      capturedIdentity = identity;
    lock.current = true;
    busyRef.current = "saving";
    setBusy("saving");
    setError(null);
    try {
      const result = await acceptTakeoffAreasAction({
        sheet_version_id: options.sheetVersionId,
        condition_id: conditionId,
        expected_scale: options.scale,
        areas: selectedAreas.map((area) => ({
          ...area,
          finishScopeNote: finishScopeNote.trim() || undefined,
        })),
        reviewed: true,
        elapsed_ms: Math.min(
          86_400_000,
          Math.max(0, Date.now() - started.current),
        ),
      });
      if (
        !mounted.current ||
        token !== request.current ||
        identityRef.current !== capturedIdentity
      )
        return false;
      if (!result.success) throw new Error(result.error);
      setAssigned((current) => ({
        ...current,
        [conditionId]: [
          ...(current[conditionId] ?? []),
          ...selectedAreas.map(signature),
        ],
      }));
      setSelected(new Set());
      setHistory([]);
      setReviewed(false);
      setFinishScopeNote("");
      options.onSaved();
      return true;
    } catch (e) {
      if (mounted.current && token === request.current)
        setError(e instanceof Error ? e.message : "Could not save areas");
      return false;
    } finally {
      if (mounted.current && token === request.current) {
        lock.current = false;
        busyRef.current = null;
        setBusy(null);
      }
    }
  };
  useEffect(() => {
    if (!visible) return;
    const key = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        (event.target instanceof Element &&
          event.target.closest(
            "[role=dialog], [role=menu], input, textarea, select",
          ))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (busy === "saving") return;
      if (pending) setPending(null);
      else if (tool !== "select") setTool("select");
      else close();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [visible, pending, tool, busy, close]);
  const currentCoverage = coverage
    ? assessAreaCoverage(
        coverage.labels.map((item) => ({
          text: item.label,
          x: item.point[0],
          y: item.point[1],
          w: 0,
          h: 0,
        })),
        proposals,
      )
    : null;
  const changeFinishPolicy = (policy: AreaFinishPolicy) => {
    if (lock.current || policy === finishPolicy) return;
    setFinishScopeNote("");
    setFinishPolicy(policy);
    setProposals([]);
    setCoverage(null);
    setSelected(new Set());
    setHistory([]);
    setReviewed(false);
    void detect(false, boundaries, policy, true);
  };
  const addManual = (points: AreaPoint[]) => {
    if (
      !options.allowed ||
      !options.scale ||
      !options.imageSize ||
      lock.current
    )
      throw new Error("Set the drawing scale before drawing an area.");
    const area: AreaProposal = recalculate({
      id: `manual-${crypto.randomUUID()}`,
      label: `Drawn area ${proposals.filter((p) => p.source === "user").length + 1}`,
      points,
      originalPoints: points,
      holes: [],
      boundary: [],
      source: "user",
      edited: true,
      warnings: [],
      areaSqft: 0,
      finishPolicy,
    });
    validateAreaGeometry(area);
    replace([...proposals, area]);
    setSelected(new Set([area.id]));
    activeIdentity.current = identity;
    setOpen(true);
    setTool("select");
  };
  const moveHandle = (
    areaId: string,
    index: number,
    point: AreaPoint,
    edge = false,
  ) => {
    if (lock.current) return;
    const area = proposals.find((p) => p.id === areaId);
    if (!area) return;
    try {
      const points = area.points.map((p) => [...p] as AreaPoint);
      if (edge) {
        const next = (index + 1) % points.length;
        const midpoint = [
          (points[index][0] + points[next][0]) / 2,
          (points[index][1] + points[next][1]) / 2,
        ];
        for (const i of [index, next])
          points[i] = [
            points[i][0] + point[0] - midpoint[0],
            points[i][1] + point[1] - midpoint[1],
          ];
      } else points[index] = point;
      const changed = recalculate({ ...area, points, edited: true });
      validateAreaGeometry(changed);
      if (points.some((p) => p.some((n) => n < 0 || n > 1)))
        throw new Error("Keep the boundary inside the drawing.");
      replace(proposals.map((p) => (p.id === areaId ? changed : p)));
      setPending(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to move this boundary");
    }
  };
  const hover = (point: AreaPoint | null) => {
    const hit = point
      ? [...availableProposals]
          .sort((a, b) => a.areaSqft - b.areaSqft)
          .find(
            (p) =>
              containsPoint(point, p.points) &&
              !p.holes.some((h) => containsPoint(point, h)),
          )
      : null;
    setHoveredId(hit?.id ?? null);
  };
  const exportDiagnostic = async () => {
    if (!diagnostic?.replayPath || !options.sheetVersionId || exportingDiagnostic) return;
    setExportingDiagnostic(true);
    try {
      const result = await exportAreaDetectionReplayAction(options.sheetVersionId, diagnostic.inputHash);
      if (!result.success) throw new Error(result.error);
      const url = URL.createObjectURL(new Blob([result.data], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `arc-area-replay-${diagnostic.inputHash.slice(0, 12)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not export detection details"); }
    finally { setExportingDiagnostic(false); }
  };
  const roomAt = (point: AreaPoint) =>
    [...availableProposals]
      .sort((a, b) => a.areaSqft - b.areaSqft)
      .find(
        (p) =>
          containsPoint(point, p.points) &&
          !p.holes.some((h) => containsPoint(point, h)),
      ) ?? null;
  const acceptInto = async (
    areas: AreaProposal[],
    destination: TakeoffCondition,
  ): Promise<boolean> => {
    if (
      !mounted.current ||
      !visible ||
      lock.current ||
      !options.sheetVersionId ||
      !options.scale ||
      areas.length === 0
    )
      return false;
    const token = ++request.current,
      capturedIdentity = identity;
    lock.current = true;
    busyRef.current = "saving";
    setBusy("saving");
    setError(null);
    try {
      const result = await acceptTakeoffAreasAction({
        sheet_version_id: options.sheetVersionId,
        condition_id: destination.id,
        expected_scale: options.scale,
        areas: areas.map((area) => ({ ...area })),
        reviewed: true,
        elapsed_ms: Math.min(86_400_000, Math.max(0, Date.now() - started.current)),
      });
      if (!mounted.current || token !== request.current || identityRef.current !== capturedIdentity)
        return false;
      if (!result.success) throw new Error(result.error);
      setAssigned((current) => ({
        ...current,
        [destination.id]: [...(current[destination.id] ?? []), ...areas.map(signature)],
      }));
      options.onSaved();
      return true;
    } catch (e) {
      if (mounted.current && token === request.current)
        setError(e instanceof Error ? e.message : "Could not save that room");
      return false;
    } finally {
      if (mounted.current && token === request.current) {
        lock.current = false;
        busyRef.current = null;
        setBusy(null);
      }
    }
  };
  /**
   * One click, one room. The smallest detected area under the point goes
   * straight into `destination` — pointing at the room on the drawing as it
   * saves is the review, so there is no separate confirm step.
   */
  const fillAt = async (
    point: AreaPoint,
    destination: TakeoffCondition,
  ): Promise<{ result: "saved" | "already" | "missed" | "failed"; area: AreaProposal | null }> => {
    const hit = roomAt(point);
    if (!hit) return { result: "missed", area: null };
    if ((assigned[destination.id] ?? []).includes(signature(hit)))
      return { result: "already", area: hit };
    return { result: (await acceptInto([hit], destination)) ? "saved" : "failed", area: hit };
  };
  /** Every detected room not yet in `destination`, in one save. */
  const fillAll = async (destination: TakeoffCondition): Promise<number> => {
    const open = availableProposals
      .filter((p) => !(assigned[destination.id] ?? []).includes(signature(p)))
      .slice(0, 50);
    return (await acceptInto(open, destination)) ? open.length : 0;
  };
  /** Forget that a room is saved to `conditionId`, after its markup is deleted. */
  const release = (area: AreaProposal, conditionId: string) =>
    setAssigned((current) => ({
      ...current,
      [conditionId]: (current[conditionId] ?? []).filter((item) => item !== signature(area)),
    }));
  return {
    roomAt,
    fillAt,
    fillAll,
    release,
    diagnostic,
    exportDiagnostic,
    exportingDiagnostic,
    moveHandle,
    addManual,
    hover,
    hoveredId,
    setHoveredId,
    restored,
    storageWarning,
    savedCount:
      (options.conditionId ? assigned[options.conditionId]?.length : 0) ?? 0,
    allProposalCount: proposals.length,
    finishScopeNote,
    changeFinishScopeNote: (note: string) => {
      setFinishScopeNote(note);
      setReviewed(false);
    },
    finishPolicy,
    changeFinishPolicy,
    coverage: currentCoverage,
    open: visible,
    activate,
    close,
    tool,
    changeTool,
    region,
    pending,
    boundaries,
    proposals: availableProposals,
    isAssignedTo,
    selected: new Set(selectedAreas.map((p) => p.id)),
    selectedAreas,
    busy,
    error,
    warnings,
    wholeSheet: () => {
      setRegion(null);
      setTool("select");
      setBoundaries([]);
      setPending(null);
      setCoverage(null);
      setProposals([]);
      setSelected(new Set());
      setHistory([]);
      setReviewed(false);
      setScaleConfirmed(false);
    },
    reviewed,
    setReviewed,
    scaleConfirmed,
    setScaleConfirmed,
    click,
    detect,
    toggle,
    merge,
    accept,
    selectAll: () => {
      setSelected(new Set(availableProposals.map((p) => p.id)));
      setReviewed(false);
    },
    clearSelection: () => {
      setSelected(new Set());
      setReviewed(false);
    },
    removeDeductions: () =>
      replace(
        proposals.map((p) =>
          selected.has(p.id)
            ? recalculate({ ...p, holes: [], edited: true })
            : p,
        ),
      ),
    undo: () => {
      const last = history[history.length - 1];
      if (last) {
        setProposals(last);
        setHistory((h) => h.slice(0, -1));
        setSelected(new Set());
        setReviewed(false);
      }
    },
    canUndo: history.length > 0,
  };
}
export type AreaTakeoffController = ReturnType<typeof useAreaTakeoff>;
