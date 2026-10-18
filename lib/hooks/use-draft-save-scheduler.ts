"use client";

import { useCallback, useEffect, useRef } from "react";

/** Invoice and estimate drafts share the same quiet two-second save cadence. */
export function useDraftSaveScheduler() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const schedule = useCallback(
    (save: () => void) => {
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        save();
      }, 2000);
    },
    [cancel],
  );
  useEffect(() => cancel, [cancel]);
  return { schedule, cancel };
}
