"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useSidebar } from "@/components/ui/sidebar";
import { useOptimisticPathname } from "@/lib/navigation/optimistic-pathname";
import { cn } from "@/lib/utils";

/** Below this width the app sidebar folds to its icon rail so the deal has room. */
const ROOMY_VIEWPORT = 1600;

/**
 * One screen: every deal on the left, the open deal on the right. A deal's
 * plans, files and full quote packages open over both, never as a second nav.
 */
export function PipelineShell({ list, children }: { list: ReactNode; children: ReactNode }) {
  const pathname = useOptimisticPathname();
  const segments = pathname.split("/").filter(Boolean);
  const dealOpen = segments.length >= 2;
  const takeover = segments.length >= 3;
  const { open, setOpen, isMobile } = useSidebar();
  const folded = useRef(false);

  useEffect(() => {
    if (isMobile || !open || window.innerWidth >= ROOMY_VIEWPORT) return;
    folded.current = true;
    setOpen(false);
    // Folding is this screen's choice, so leaving it gives the sidebar back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);
  useEffect(
    () => () => {
      if (folded.current) setOpen(true);
    },
    [setOpen],
  );

  return (
    <div className="grid h-full min-h-0 lg:grid-cols-[19rem_minmax(0,1fr)]">
      <aside
        aria-label="Pipeline"
        className={cn(
          "min-h-0 border-r bg-muted/40",
          takeover ? "hidden" : dealOpen ? "hidden lg:block" : "block",
        )}
      >
        {list}
      </aside>
      <div
        className={cn(
          "min-h-0 min-w-0",
          !dealOpen && "hidden lg:block",
          takeover && "lg:col-span-2",
        )}
      >
        {children}
      </div>
    </div>
  );
}
