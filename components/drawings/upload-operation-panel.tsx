"use client"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import type { useDrawingUploadOperation } from "@/lib/hooks/use-drawing-upload-operation"
import { toast } from "sonner"

export function UploadOperationPanel({ operation, onResume }: { operation: ReturnType<typeof useDrawingUploadOperation>; onResume: () => void }) {
  if (!operation.saved && operation.state !== "transferring") return operation.state === "completed" && operation.stage ? <p role="status" className="border p-3 text-sm">{operation.stage}</p> : null
  const running = ["transferring", "reconciling", "completion-unknown"].includes(operation.state)
  return <section aria-label="Drawing upload" className="space-y-2 border p-3">
    <p role="status" className="text-sm">{operation.stage || "Upload paused. Reselect the same PDF to resume."}</p>
    {operation.progress && <Progress aria-label="Upload progress" value={operation.progress.percent} />}
    <div className="flex gap-2">
      {running ? <Button size="sm" variant="outline" onClick={operation.pause}>Pause upload</Button> : <Button size="sm" onClick={onResume}>Resume upload</Button>}
      <Button size="sm" variant="ghost" onClick={() => void operation.cancel().catch(error => toast.error(error instanceof Error ? error.message : "Unable to cancel upload"))}>Cancel upload</Button>
    </div>
    <p className="text-xs text-muted-foreground">Keep this tab open during transfer. Processing continues after the PDF is registered.</p>
  </section>
}
