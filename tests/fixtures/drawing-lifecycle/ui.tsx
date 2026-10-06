import { useState } from "react"
import { createRoot } from "react-dom/client"
import { RevisionReviewDialog } from "@/components/drawings/revision-review-dialog"
import { useDrawingUploadOperation } from "@/lib/hooks/use-drawing-upload-operation"
import { UploadOperationPanel } from "@/components/drawings/upload-operation-panel"
function UploadHarness() {
  const operation = useDrawingUploadOperation("fixture-project")
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState("")
  const start = (targetSheetId?: string) => {
    if (!file) return
    setError("")
    void operation.run(file, {projectId:"fixture-project",fileName:file.name,fileSize:file.size,mimeType:"application/pdf",targetSheetId}).catch(e=>setError(e.message))
  }
  return <><input aria-label="Choose fixture PDF" type="file" onChange={e=>setFile(e.target.files?.[0]??null)} />
    <button onClick={()=>start()}>Upload package</button><button onClick={()=>start("fixture-sheet")}>Replace sheet</button>
    <output aria-label="Operation state">{operation.state}</output><output aria-label="Upload error">{error}</output>
    <UploadOperationPanel operation={operation} onResume={()=>start(operation.saved?.intent.targetSheetId)} /></>
}
function Harness() {
  const [open, setOpen] = useState(true)
  const [discarded, setDiscarded] = useState(false)
  const [published, setPublished] = useState(false)
  return <><output>{published ? "Publication acknowledged" : discarded ? "Deletion acknowledged" : "Fixture ready"}</output><RevisionReviewDialog open={open} onOpenChange={setOpen} revisionId="fixture-revision" onPublished={() => setPublished(true)} onDiscarded={() => setDiscarded(true)} /></>
}
const root = document.getElementById("root")
if (!root) throw new Error("Missing fixture root")
createRoot(root).render(location.search.includes("upload") ? <UploadHarness /> : <Harness />)
