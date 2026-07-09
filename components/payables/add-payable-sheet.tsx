"use client"

import { type DragEvent, useState, useTransition, useEffect, useRef } from "react"
import { toast } from "sonner"
import { format } from "date-fns"
import {
  Check,
  ChevronsUpDown,
  Loader2,
  Receipt, 
  Upload, 
  X, 
  Calendar as CalendarIcon, 
  FileText,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Calendar } from "@/components/ui/calendar"
import { CompanyForm } from "@/components/companies/company-form"
import { createCompanyAction, listCompaniesAction } from "@/app/(app)/companies/actions"
import { uploadFileAction } from "@/app/(app)/documents/actions"
import {
  createProjectVendorBillAction,
  extractPayableInvoiceAction,
  listProjectCommitmentsForPayablesAction,
} from "@/app/(app)/projects/[id]/payables/actions"
import type { CommitmentSummary } from "@/lib/services/commitments"
import type { Company } from "@/lib/types"

import { unwrapAction } from "@/lib/action-result"

const NO_COMMITMENT = "__no_commitment__"

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase()
}

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

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
  const [companies, setCompanies] = useState<Company[]>([])
  const [loadingCommitments, setLoadingCommitments] = useState(false)
  const [loadingCompanies, setLoadingCompanies] = useState(false)
  const [isCreatingVendor, startCreateVendorTransition] = useTransition()

  // Form state
  const [commitmentId, setCommitmentId] = useState(NO_COMMITMENT)
  const [companyId, setCompanyId] = useState("")
  const [vendorName, setVendorName] = useState("")
  const [vendorPickerOpen, setVendorPickerOpen] = useState(false)
  const [vendorEditorOpen, setVendorEditorOpen] = useState(false)
  const [vendorEditorCompany, setVendorEditorCompany] = useState<Company | null>(null)
  const [billNumber, setBillNumber] = useState("")
  const [amountDollars, setAmountDollars] = useState("")
  const [billDate, setBillDate] = useState<Date>(new Date())
  const [dueDate, setDueDate] = useState<Date | undefined>()
  const [description, setDescription] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [isScanning, setIsScanning] = useState(false)
  const [isDraggingFile, setIsDraggingFile] = useState(false)

  useEffect(() => {
    if (open) {
      setLoadingCommitments(true)
      setLoadingCompanies(true)
      listProjectCommitmentsForPayablesAction(projectId)
        .then(setCommitments)
        .catch(() => toast.error("Failed to load commitments"))
        .finally(() => setLoadingCommitments(false))
      listCompaniesAction()
        .then((rows) => setCompanies(rows.filter((company) => company.company_type === "subcontractor" || company.company_type === "supplier" || company.company_type === "other")))
        .catch(() => toast.error("Failed to load vendors"))
        .finally(() => setLoadingCompanies(false))
    }
  }, [open, projectId])

  const amountCents = Math.round((Number.parseFloat(amountDollars) || 0) * 100)
  const selectedCommitment =
    commitmentId !== NO_COMMITMENT ? commitments.find((commitment) => commitment.id === commitmentId) ?? null : null
  const commitmentBilledCents = selectedCommitment?.billed_cents ?? 0
  const commitmentTotalCents = selectedCommitment?.total_cents ?? 0
  const commitmentAfterBillCents = commitmentBilledCents + amountCents
  const commitmentOverBudget = Boolean(selectedCommitment && commitmentTotalCents > 0 && commitmentAfterBillCents > commitmentTotalCents)
  const selectedCompany = companyId ? companies.find((company) => company.id === companyId) ?? vendorEditorCompany : null
  const vendorCommitments = companyId ? commitments.filter((commitment) => commitment.company_id === companyId) : []
  const visibleCompanies = companies.filter(
    (company) => !vendorName.trim() || normalizeName(company.name).includes(normalizeName(vendorName)),
  )
  const exactCompany = vendorName.trim()
    ? companies.find((company) => normalizeName(company.name) === normalizeName(vendorName))
    : null
  const canCreateVendor = vendorName.trim().length >= 2 && !exactCompany
  const isValid = billNumber && amountCents > 0 && billDate && (companyId || commitmentId !== NO_COMMITMENT)

  function applyVendor(value: string) {
    setVendorName(value)
    const exact = companies.find((company) => normalizeName(company.name) === normalizeName(value))
    setCompanyId(exact?.id ?? "")
    if (value.trim()) {
      const matchingCommitment = commitments.find(
        (commitment) => commitment.company_name && normalizeName(commitment.company_name) === normalizeName(value),
      )
      if (matchingCommitment) {
        setCommitmentId(matchingCommitment.id)
        setCompanyId(matchingCommitment.company_id ?? exact?.id ?? "")
      }
    }
  }

  function selectCompany(company: Company) {
    setCompanyId(company.id)
    setVendorName(company.name)
    const matchingCommitment = commitments.find((commitment) => commitment.company_id === company.id)
    if (matchingCommitment) setCommitmentId(matchingCommitment.id)
    setVendorPickerOpen(false)
  }

  function handleCommitmentChange(value: string) {
    setCommitmentId(value)
    if (value === NO_COMMITMENT) return
    const commitment = commitments.find((item) => item.id === value)
    if (!commitment) return
    setCompanyId(commitment.company_id ?? "")
    setVendorName(commitment.company_name ?? vendorName)
  }

  function createArcVendor() {
    const name = vendorName.trim()
    if (!name) return
    startCreateVendorTransition(async () => {
      try {
        const company = unwrapAction(await createCompanyAction({
          name,
          company_type: "supplier",
        }))
        setCompanies((prev) => {
          if (prev.some((item) => item.id === company.id)) return prev
          return [...prev, company].sort((a, b) => a.name.localeCompare(b.name))
        })
        setCompanyId(company.id)
        setVendorName(company.name)
        setVendorEditorCompany(company)
        setVendorEditorOpen(true)
        setVendorPickerOpen(false)
        toast.success("Arc vendor created")
      } catch (error) {
        toast.error((error as Error).message)
      }
    })
  }

  async function handleFileSelected(nextFile: File | null) {
    setFile(nextFile)
    if (!nextFile) return

    setIsScanning(true)
    try {
      const formData = new FormData()
      formData.append("invoice", nextFile)
      const result = unwrapAction(await extractPayableInvoiceAction(projectId, formData))
      if (!result.ok) {
        toast.error(result.error)
        return
      }

      const data = result.data
      if (data.vendorName) applyVendor(data.vendorName)
      if (data.billNumber) setBillNumber(data.billNumber)
      if (data.totalDollars !== null) setAmountDollars(data.totalDollars.toFixed(2))
      if (data.billDate) setBillDate(new Date(`${data.billDate}T00:00:00`))
      if (data.dueDate) setDueDate(new Date(`${data.dueDate}T00:00:00`))
      if (data.description) setDescription(data.description)
      toast.success("Invoice details scanned")
    } finally {
      setIsScanning(false)
    }
  }

  function handleFileDrag(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (event.type === "dragenter" || event.type === "dragover") {
      setIsDraggingFile(true)
    } else if (event.type === "dragleave") {
      setIsDraggingFile(false)
    }
  }

  function handleFileDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    setIsDraggingFile(false)

    const droppedFile = event.dataTransfer.files?.[0] ?? null
    if (!droppedFile) return
    void handleFileSelected(droppedFile)
  }

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
          const uploaded = unwrapAction(await uploadFileAction(formData))
          fileId = uploaded.id
          setIsUploading(false)
        }

        const result = unwrapAction(await createProjectVendorBillAction(projectId, {
          commitment_id: commitmentId === NO_COMMITMENT ? null : commitmentId,
          company_id: companyId || undefined,
          vendor_name: selectedCompany?.name ?? (vendorName.trim() || undefined),
          bill_number: billNumber,
          total_cents: amountCents,
          bill_date: format(billDate, "yyyy-MM-dd"),
          due_date: dueDate ? format(dueDate, "yyyy-MM-dd") : undefined,
          description: description || undefined,
          file_id: fileId,
        }))
        if (!result.success) {
          toast.error(result.error)
          setIsUploading(false)
          return
        }

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
    setCommitmentId(NO_COMMITMENT)
    setCompanyId("")
    setVendorName("")
    setVendorEditorCompany(null)
    setVendorEditorOpen(false)
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
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleFileSelected(null)}>
                  <X className="h-4 w-4" />
                </Button>
                {isScanning ? <span className="text-xs text-muted-foreground">Scanning invoice...</span> : null}
              </div>
            ) : (
              <div 
                className={cn(
                  "border-2 border-dashed rounded-xl py-8 flex flex-col items-center justify-center bg-muted/5 hover:bg-muted/10 transition-colors cursor-pointer group",
                  isDraggingFile && "border-primary bg-primary/5",
                )}
                onClick={() => fileInputRef.current?.click()}
                onDragEnter={handleFileDrag}
                onDragOver={handleFileDrag}
                onDragLeave={handleFileDrag}
                onDrop={handleFileDrop}
              >
                <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                  <Upload className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium">{isDraggingFile ? "Drop invoice here" : "Drop or click to upload invoice PDF"}</p>
                <p className="text-[10px] text-muted-foreground mt-1 uppercase font-bold">Max size 20MB</p>
                <input 
                  ref={fileInputRef}
                  id="payable-file-upload" 
                  type="file" 
                  className="hidden" 
                  accept="application/pdf,image/*" 
                  onChange={(e) => handleFileSelected(e.target.files?.[0] || null)}
                />
              </div>
            )}
          </div>

          {/* Details Section */}
          <div className="space-y-6">
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Arc vendor</Label>
              <Popover open={vendorPickerOpen} onOpenChange={setVendorPickerOpen}>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" role="combobox" className="h-11 w-full justify-between px-3 text-left">
                    <span className={cn("truncate", !selectedCompany && "text-muted-foreground")}>
                      {selectedCompany?.name ?? (vendorName || "Select Arc vendor")}
                    </span>
                    <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput value={vendorName} onValueChange={applyVendor} placeholder="Search Arc vendors..." />
                    <CommandList className="max-h-72 overflow-y-auto">
                      <CommandEmpty>{loadingCompanies ? "Loading vendors..." : "No matching Arc vendors."}</CommandEmpty>
                      <CommandGroup heading="Arc vendors">
                        {visibleCompanies.map((company) => {
                          const selected = company.id === companyId
                          return (
                            <CommandItem key={company.id} value={company.name} onSelect={() => selectCompany(company)}>
                              <Check className={cn("size-4", selected ? "opacity-100" : "opacity-0")} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate">{company.name}</span>
                                <span className="block truncate text-xs text-muted-foreground">
                                  {company.qbo_vendor_id ? `QBO: ${company.qbo_vendor_name ?? "Linked"}` : "No QBO vendor linked"}
                                </span>
                              </span>
                            </CommandItem>
                          )
                        })}
                      </CommandGroup>
                      {canCreateVendor ? (
                        <CommandGroup heading="New vendor">
                          <CommandItem value={`Create ${vendorName}`} onSelect={createArcVendor}>
                            {isCreatingVendor ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4 opacity-0" />}
                            <span>Create Arc vendor “{vendorName.trim()}”</span>
                          </CommandItem>
                        </CommandGroup>
                      ) : null}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              <p className="text-xs text-muted-foreground">
                Pick an Arc vendor first. New vendors can be created here, then linked to QuickBooks from their profile.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Source Commitment</Label>
              <Select value={commitmentId} onValueChange={handleCommitmentChange}>
                <SelectTrigger className="h-11">
                  <SelectValue placeholder={loadingCommitments ? "Loading..." : "Select commitment"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_COMMITMENT}>
                    <span className="font-medium">No commitment</span>
                  </SelectItem>
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
              {vendorCommitments.length > 1 ? (
                <div className="border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
                  <span className="font-medium">{selectedCompany?.name ?? "This vendor"} has {vendorCommitments.length} commitments on this project.</span>{" "}
                  Arc pre-selected one — confirm the source commitment matches the invoice before saving.
                </div>
              ) : null}
              {selectedCommitment ? (
                <div
                  className={cn(
                    "border px-3 py-2 text-xs",
                    commitmentOverBudget
                      ? "border-destructive/30 bg-destructive/10 text-destructive"
                      : "border-success/20 bg-success/10 text-success",
                  )}
                >
                  <div className="font-medium">
                    Billed to date {formatMoney(commitmentBilledCents)} of {formatMoney(commitmentTotalCents)}
                  </div>
                  <div className="mt-0.5">
                    This bill takes the commitment to {formatMoney(commitmentAfterBillCents)}
                    {commitmentTotalCents > 0 ? ` (${Math.round((commitmentAfterBillCents / commitmentTotalCents) * 100)}%)` : ""}.
                  </div>
                </div>
              ) : null}
              {selectedCommitment && !selectedCommitment.executed_at ? (
                <div className="border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                  <div className="font-medium">No executed subcontract on this commitment</div>
                  <div className="mt-0.5">
                    You are billing against an agreement the vendor has not signed. Send the subcontract for
                    signature from the Commitments tab.
                  </div>
                </div>
              ) : null}
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
            disabled={!isValid || isPending || isUploading || isScanning}
            onClick={handleSubmit}
          >
            {isScanning ? "Scanning..." : isPending || isUploading ? (isUploading ? "Uploading..." : "Saving...") : "Add Payable"}
          </Button>
        </SheetFooter>
      </SheetContent>
      <Sheet open={vendorEditorOpen} onOpenChange={setVendorEditorOpen}>
        <SheetContent side="right" mobileFullscreen className="flex flex-col p-0 sm:max-w-xl">
          <SheetHeader className="border-b bg-muted/30 px-6 py-5">
            <SheetTitle>Vendor details</SheetTitle>
            <SheetDescription>
              Link this Arc vendor to QuickBooks before saving payables for it.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {vendorEditorCompany ? (
              <CompanyForm
                company={vendorEditorCompany}
                onSubmitted={() => {
                  setVendorEditorOpen(false)
                  listCompaniesAction()
                    .then((rows) => setCompanies(rows.filter((company) => company.company_type === "subcontractor" || company.company_type === "supplier" || company.company_type === "other")))
                    .catch(() => {})
                }}
                onCancel={() => setVendorEditorOpen(false)}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </Sheet>
  )
}
