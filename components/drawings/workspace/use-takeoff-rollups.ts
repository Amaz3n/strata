"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getConditionRollupAction } from "@/app/(app)/drawings/takeoff-actions";
import type { ConditionRollup } from "@/lib/services/takeoff";

import type { TakeoffScope } from "./item-picker";

/**
 * The takeoff, loaded once for the whole workspace. The ledger, the item
 * picker, the estimate handoff and the 3D "Takeoff" look all read the same
 * rows, so a measurement saved on the sheet repaints all four together.
 */
export function useTakeoffRollups(scope: TakeoffScope | null, refreshToken: number) {
  const [rollups, setRollups] = useState<ConditionRollup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const scopeKey = scope ? ("project_id" in scope ? `p:${scope.project_id}` : `v:${scope.house_plan_version_id}`) : null;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const load = useCallback(async () => {
    const current = scopeRef.current;
    if (!current) return;
    const token = ++request.current;
    setError(null);
    try {
      const next = await getConditionRollupAction(current);
      if (token === request.current) setRollups(next);
    } catch (failure) {
      if (token !== request.current) return;
      setError(failure instanceof Error ? failure.message : "Couldn't load the takeoff");
      setRollups((previous) => previous ?? []);
    }
  }, []);

  useEffect(() => {
    if (!scopeKey) {
      setRollups(null);
      return;
    }
    void load();
  }, [scopeKey, refreshToken, load]);

  return { rollups, error, reload: load };
}
