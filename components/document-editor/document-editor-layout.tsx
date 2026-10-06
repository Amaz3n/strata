"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

export function DocumentEditorLayout({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col lg:flex-row", className)}
      {...props}
    />
  );
}

export function DocumentEditorFields({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto", className)}
      {...props}
    />
  );
}

export function DocumentPreviewPane({
  children,
  className,
  ...props
}: ComponentProps<"aside">) {
  return (
    <aside
      aria-label="Live document preview"
      className={cn(
        "min-h-0 flex-1 flex-col bg-muted/40 lg:flex lg:w-[46%] lg:max-w-[880px] lg:flex-none lg:shrink-0 lg:border-l",
        className,
      )}
      {...props}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-6">{children}</div>
    </aside>
  );
}

/** Shared letter-size canvas. React updates its contents in place on every keystroke. */
export function ScaledDocument({
  children,
  width = 816,
  minHeight = 1056,
}: {
  children: ReactNode;
  width?: number;
  minHeight?: number;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ scale: 0.8, height: minHeight });
  useLayoutEffect(() => {
    const frame = frameRef.current,
      content = contentRef.current;
    if (!frame || !content) return;
    const update = () => {
      const scale = Math.min(1, Math.max(0.1, frame.clientWidth / width));
      const height = Math.max(minHeight, content.offsetHeight);
      setSize((previous) =>
        previous.scale === scale && previous.height === height
          ? previous
          : { scale, height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    observer.observe(content);
    return () => observer.disconnect();
  }, [width, minHeight]);
  return (
    <div ref={frameRef} className="mx-auto w-full" style={{ maxWidth: width }}>
      <div
        className="relative shadow-md"
        style={{ width: width * size.scale, height: size.height * size.scale }}
      >
        <div
          ref={contentRef}
          className="absolute left-0 top-0 origin-top-left bg-[var(--paper)] text-[var(--paper-ink)]"
          style={{ width, minHeight, transform: `scale(${size.scale})` }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
