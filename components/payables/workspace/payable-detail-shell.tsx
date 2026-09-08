"use client";

import { useEffect, useRef, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";

/** A bill keeps the desk's place and sequence, without duplicating the desk. */
export function PayableDetailShell({
  children,
  documentPane,
  title,
  onClose,
  onPrevious,
  onNext,
  position,
  paymentOpen,
}: {
  children: ReactNode;
  documentPane: ReactNode;
  title: string;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  position?: string;
  paymentOpen: boolean;
}) {
  const returnFocus = useRef<HTMLElement | null>(
    typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement),
  );
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("arc-immersive-view", { detail: { active: true } }),
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent("arc-immersive-view", { detail: { active: false } }),
      );
    };
  }, []);

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          onCloseAutoFocus={(event) => {
            if (returnFocus.current?.isConnected) {
              event.preventDefault();
              returnFocus.current.focus();
            }
          }}
          data-payable-detail
          aria-describedby={undefined}
          onPointerDownOutside={(event) => event.preventDefault()}
          className="fixed inset-0 z-50 flex h-dvh flex-col bg-background text-foreground outline-none"
        >
          <DialogPrimitive.Title className="sr-only">
            {title}
          </DialogPrimitive.Title>
          <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 sm:px-8">
            <Button
              variant="ghost"
              className="-ml-2 gap-2 rounded-lg text-muted-foreground"
              onClick={onClose}
            >
              <ArrowLeft className="size-4" />
              {paymentOpen ? "Back to bill" : "Payables"}
            </Button>
            <div className="flex items-center gap-2 sm:gap-5">
              {!paymentOpen && position ? (
                <div className="flex items-center gap-1">
                  <span className="mr-2 hidden text-xs tabular-nums text-muted-foreground sm:inline">
                    {position}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-9 rounded-lg"
                    aria-label="Previous bill"
                    disabled={!onPrevious}
                    onClick={onPrevious}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-9 rounded-lg"
                    aria-label="Next bill"
                    disabled={!onNext}
                    onClick={onNext}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              ) : null}
            </div>
          </header>
          <div className="flex min-h-0 flex-1 flex-col min-[1100px]:flex-row">
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">
              {children}
            </main>
            <aside
              aria-label="Invoice and supporting documents"
              className="flex h-[38%] min-h-[220px] min-w-0 shrink-0 flex-col border-t border-border/60 bg-muted/30 min-[1100px]:h-auto min-[1100px]:w-[46%] min-[1100px]:border-l min-[1100px]:border-t-0"
            >
              {documentPane}
            </aside>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
