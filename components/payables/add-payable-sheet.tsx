"use client"

import { useState, useTransition, useEffect } from "react"
import { toast } from "sonner"
import { format } from "date-fns"
import { 
  Receipt, 
  Plus, 
  Upload, 
  X, 
  Calendar as CalendarIcon, 
  Building2, 
  FileText,
  AlertCircle
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar } from "@/components/ui/calendar"
import { uploadFileAction } from "@/app/(app)/documents/actions"
import { createProjectVendorBillAction, listProjectCommitmentsForPayablesAction } from "@/app/(app)/projects/[id]/payables/actions"
import type { CommitmentSummary } from "@/lib/services/commitments"

interface AddPayableSheetProps {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

export function AddPayableSheet({
  projectId,
  open,
  onOpenChange,
  onSuccess,
}: AddPayableSheetProps) {
  const [isPending, startTransition] = useTransition()
  const [commitments, setCommitments] = useState<CommitmentSummary[]>([])
  const [loadingCommitments, setLoadingCommitments] = useState(false)

  // Form state
  const [commitmentId, setCommitmentId] = useState("")
  const [billNumber, setBillNumber] = useState("")
  const [amountDollars, setAmountDollars] = useState("")
  const [billDate, setBillDate] = useState<Date>(new Date())
  const [dueDate, setDueDate] = useState<Date | undefined>()
  const [description, setDescription] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [isUploading, setIsUploading] = useState(false)

  useEffect(() => {
    if (open) {
      setLoadingCommitments(true)
      listProjectCommitmentsForPayablesAction(projectId)
        .then(setCommitments)
        .catch(err => toast.error("Failed to load commitments"))
        .finally(() => setLoadingCommitments(false))
    }
  }, [open, projectId])

  const amountCents = Math.round((Number.parseFloat(amountDollars) || 0) * 100)
  const isValid = commitmentId && billNumber && amountCents > 0 && billDate

  const handleSubmit = () => {
    startTransition(async () => {
      try {
        let fileId = null
        if (file) {
          setIsUploading(true)
          const formData = new FormData()
          formData.append("file", file)
          formData.append("projectId", projectId)
          formData.append("category", "financials")
          const uploaded = await uploadFileAction(formData)
          fileId = uploaded.id
          setIsUploading(false)
        }

        await createProjectVendorBillAction(projectId, {
          commitment_id: commitmentId,
          bill_number: billNumber,
          total_cents: amountCents,
          bill_date: format(billDate, "yyyy-MM-dd"),
          due_date: dueDate ? format(dueDate, "yyyy-MM-dd") : undefined,
          description: description || undefined,
          file_id: fileId,
        })

        toast.success("Payable added successfully")
        onOpenChange(false)
        resetForm()
        onSuccess?.()
      } catch (error) {
        toast.error((error as Error).message)
        setIsUploading(false)
      }
    })
  }

  const resetForm = () => {
    setCommitmentId("")
    setBillNumber("")
    setAmountDollars("")
    setBillDate(new Date())
    setDueDate(undefined)
    setDescription("")
    setFile(null)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-xl w-full flex flex-col p-0">
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5 text-primary" />
            Add Vendor Payable
          </SheetTitle>
          <SheetDescription>
            Record an invoice or bill received from a subcontractor or vendor.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-8">
          {/* File Upload Area */}
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Invoice Document</Label>
            {file ? (
              <div className="flex items-center justify-between p-3 border rounded-lg bg-primary/5 border-primary/20">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded bg-primary/10 flex items-center justify-center text-primary">
                    <FileText className="h-5 w-5" />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium truncate max-w-[240px]">{file.name}</span>
                    <span className="text-[10px] text-muted-foreground uppercase font-bold">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                  </div>
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setFile(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div 
                className="border-2 border-dashed rounded-xl py-8 flex flex-col items-center justify-center bg-muted/5 hover:bg-muted/10 transition-colors cursor-pointer group"
                onClick={() => document.getElementById("payable-file-upload")?.click()}
              >
                <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                  <Upload className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium">Click to upload invoice PDF</p>
                <p className="text-[10px] text-muted-foreground mt-1 uppercase font-bold">Max size 20MB</p>
                <input 
                  id="payable-file-upload" 
                  type="file" 
                  className="hidden" 
                  accept="application/pdf,image/*" 
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </div>
            )}
          </div>

          {/* Details Section */}
          <div className="space-y-6">
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Source Commitment</Label>
              <Select value={commitmentId} onValueChange={setCommitmentId}>
                <SelectTrigger className="h-11">
                  <SelectValue placeholder={loadingCommitments ? "Loading..." : "Select commitment or contract"} />
                </SelectTrigger>
                <SelectContent>
                  {commitments.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <div className="flex flex-col">
                        <span className="font-medium">{c.title}</span>
                        <span className="text-[10px] text-muted-foreground uppercase">{c.company_name || "No company"}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Bill / Invoice #</Label>
                <Input 
                  value={billNumber} 
                  onChange={(e) => setBillNumber(e.target.value)}
                  placeholder="e.g., INV-1002"
                  className="h-11"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Total Amount</Label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <span className="text-muted-foreground sm:text-sm">$</span>
                  </div>
                  <Input
                    className="pl-7 h-11"
                    inputMode="decimal"
                    value={amountDollars}
                    onChange={(e) => setAmountDollars(e.target.value.replace(/[^\d.]/g, ""))}
                    placeholder="0.00"
                  />
                </div>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Bill Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className={cn("w-full h-11 justify-start text-left font-normal", !billDate && "text-muted-foreground")}>
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {billDate ? format(billDate, "PPP") : <span>Select date</span>}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar mode="single" selected={billDate} onSelect={(date) => date && setBillDate(date)} initialFocus />
                  </PopoverContent>
                </Popover>
              </div>
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Due Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className={cn("w-full h-11 justify-start text-left font-normal", !dueDate && "text-muted-foreground")}>
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {dueDate ? format(dueDate, "PPP") : <span>Select date</span>}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar mode="single" selected={dueDate} onSelect={setDueDate} initialFocus />
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Notes / Memo</Label>
              <Textarea 
                value={description} 
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description of the work performed..."
                rows={4}
              />
            </div>
          </div>
        </div>

        <SheetFooter className="p-6 border-t bg-muted/10 grid grid-cols-2 gap-4">
          <Button variant="outline" className="w-full h-11" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button 
            className="w-full h-11 shadow-lg" 
            disabled={!isValid || isPending || isUploading}
            onClick={handleSubmit}
          >
            {isPending || isUploading ? (isUploading ? "Uploading..." : "Saving...") : "Add Payable"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
