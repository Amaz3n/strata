"use client"

import { useEffect, useRef, useState } from "react"
import { Document, Page } from "react-pdf"
import { ChevronLeft, ChevronRight, FileWarning, Loader2 } from "lucide-react"
import { configurePdfWorker } from "@/lib/pdf/worker"
import { WAIVER_FIELDS, type WaiverPlacement, type WaiverFieldKey } from "@/lib/lien-waivers/invoice-waiver"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

configurePdfWorker()
const OPTIONS = { isEvalSupported: false }

export function WaiverPdfPreview({ url, fields = [], activeField, selectedId, onPlace, onSelect, onChange, onReady }: {
  url: string; fields?: WaiverPlacement[]; activeField?: WaiverFieldKey | null; selectedId?: string | null;
  onPlace?: (key: WaiverFieldKey, page: number, x: number, y: number) => void;
  onSelect?: (id: string) => void; onChange?: (field: WaiverPlacement) => void; onReady?: () => void;
}) {
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(500)
  const [pages, setPages] = useState(0)
  const [page, setPage] = useState(1)
  const [error, setError] = useState(false)
  useEffect(() => {
    const node = container.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(160, Math.min(760, entry.contentRect.width - 40))))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => { setPage(1); setError(false) }, [url])
  return <div className="flex min-h-0 flex-1 flex-col bg-muted/35" ref={container}>
    <div className="flex h-11 shrink-0 items-center justify-between border-b px-4 text-xs text-muted-foreground">
      <span>{onPlace ? "Place fields on your original form" : "Document preview"}</span>
      <div className="flex items-center gap-1">
        <Button size="icon" variant="ghost" className="size-7" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((n) => n - 1)}><ChevronLeft className="size-3.5" /></Button>
        <span className="min-w-12 text-center tabular-nums">{page} / {pages || "–"}</span>
        <Button size="icon" variant="ghost" className="size-7" aria-label="Next page" disabled={page >= pages} onClick={() => setPage((n) => n + 1)}><ChevronRight className="size-3.5" /></Button>
      </div>
    </div>
    <div className="min-h-0 flex-1 overflow-auto p-5">
      {error ? <div role="alert" className="mx-auto flex max-w-xs flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground"><FileWarning className="size-7" /><p>This PDF could not be previewed. Try an unlocked PDF.</p><a className="underline" href={url} target="_blank" rel="noreferrer">Open document</a></div> :
        <Document file={url} options={OPTIONS} onLoadSuccess={({ numPages }) => setPages(numPages)} onLoadError={() => setError(true)}
          loading={<div className="flex justify-center py-24" role="status"><Loader2 className="size-5 animate-spin motion-reduce:animate-none" /><span className="sr-only">Loading document</span></div>}>
          <div className={cn("relative mx-auto w-fit overflow-hidden bg-white shadow-sm", activeField && "cursor-crosshair")}
            onClick={(event) => {
              if (!activeField || !onPlace) return
              const box = event.currentTarget.getBoundingClientRect()
              onPlace(activeField, page - 1, (event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height)
            }}>
            <Page pageNumber={page} width={width} renderTextLayer={false} renderAnnotationLayer={false} onRenderSuccess={onReady} onRenderError={() => setError(true)} />
            {fields.filter((f) => f.page === page - 1).map((field) => <button key={field.id} type="button"
              aria-label={`${WAIVER_FIELDS[field.key]}. Arrow keys move the field.`}
              onClick={(event) => { event.stopPropagation(); onSelect?.(field.id) }}
              onKeyDown={(event) => {
                const offsets: Record<string, [number, number]> = { ArrowLeft: [-0.005, 0], ArrowRight: [0.005, 0], ArrowUp: [0, -0.005], ArrowDown: [0, 0.005] }
                const offset = offsets[event.key]
                if (!offset) return
                event.preventDefault()
                onChange?.({ ...field, x: Math.max(0, Math.min(1 - field.width, field.x + offset[0])), y: Math.max(0, Math.min(1 - field.height, field.y + offset[1])) })
              }}
              className={cn("absolute overflow-hidden rounded-sm border border-primary/50 bg-primary/10 px-1 text-left text-[10px] leading-none text-primary outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary", selectedId === field.id && "border-primary bg-primary/20 ring-1 ring-primary")}
              style={{ left: `${field.x * 100}%`, top: `${field.y * 100}%`, width: `${field.width * 100}%`, height: `${field.height * 100}%` }}>
              {WAIVER_FIELDS[field.key]}
            </button>)}
          </div>
        </Document>}
    </div>
  </div>
}
