"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function BulkSelectionIsland({
  count,
  label,
  onClear,
  children,
}: {
  count: number;
  label: string;
  onClear: () => void;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          role="region"
          aria-label={label}
          initial={
            reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }
          }
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={
            reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.985 }
          }
          transition={
            reducedMotion
              ? { duration: 0.1 }
              : { type: "spring", bounce: 0, duration: 0.24 }
          }
          layout={!reducedMotion}
          className="absolute bottom-16 left-1/2 z-30 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 border border-border/80 bg-background/95 p-2 shadow-[0_12px_40px_rgba(0,0,0,0.18)] backdrop-blur-md"
        >
          <span className="whitespace-nowrap px-2 text-sm font-medium tabular-nums">
            {count} selected
          </span>
          {children}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Clear selection"
            onClick={onClear}
          >
            <X className="size-4" />
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
