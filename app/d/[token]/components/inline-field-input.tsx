"use client"

import { useEffect, useMemo, useState } from "react"

import { CalendarDays, Check } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

import { SignatureCapture } from "./signature-capture"
import { normalizeFieldLabel, type SigningField } from "./types"

interface ApplyOptions {
  advance?: boolean
  adoptSignature?: boolean
  updateSignerName?: boolean
}

interface InlineFieldInputProps {
  field: SigningField | null
  value: unknown
  signerName: string
  adoptedSignature?: string | null
  onApply: (value: unknown, options?: ApplyOptions) => void
}

function getTodayIsoDate() {
  return new Date().toISOString().split("T")[0]
}

export function InlineFieldInput({ field, value, signerName, adoptedSignature, onApply }: InlineFieldInputProps) {
  const [textValue, setTextValue] = useState("")
  const [checkboxValue, setCheckboxValue] = useState(value === true)

  useEffect(() => {
    if (!field) return

    if (field.field_type === "checkbox") {
      setCheckboxValue(value === true)
      return
    }

    if (typeof value === "string") {
      setTextValue(value)
      return
    }

    if (field.field_type === "date") {
      setTextValue(getTodayIsoDate())
      return
    }

    if (field.field_type === "name" && signerName.trim()) {
      setTextValue(signerName)
      return
    }

    setTextValue("")
  }, [field, signerName, value])

  const heading = useMemo(() => (field ? normalizeFieldLabel(field) : "Select a field"), [field])

  if (!field) {
    return (
      <div className="rounded-lg border bg-card p-4">
        <p className="text-xs text-muted-foreground">Inline editor</p>
        <p className="mt-1 text-sm text-muted-foreground">Select a field on the document to begin editing.</p>
      </div>
    )
  }

  if (field.field_type === "signature") {
    return (
      <SignatureCapture
        fieldLabel={heading}
        adoptedSignature={adoptedSignature}
        onApply={(signatureDataUrl, options) => onApply(signatureDataUrl, { advance: true, adoptSignature: options.adopt })}
      />
    )
  }

  if (field.field_type === "checkbox") {
    return (
      <div className="space-y-3 rounded-lg border bg-card p-4">
        <div>
          <p className="text-xs text-muted-foreground">Checkbox field</p>
          <h3 className="text-sm font-semibold">{heading}</h3>
        </div>

        <div className="flex items-center gap-3 rounded-md border bg-muted/40 px-3 py-2">
          <Checkbox
            checked={checkboxValue}
            onCheckedChange={(checked) => {
              const next = checked === true
              setCheckboxValue(next)
              onApply(next, { advance: true })
            }}
          />
          <span className="text-sm">Mark this checkbox</span>
        </div>
        <p className="text-xs text-muted-foreground">Toggling this checkbox saves and moves to the next field.</p>
      </div>
    )
  }

  const isDate = field.field_type === "date"
  const isName = field.field_type === "name"

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div>
        <p className="text-xs text-muted-foreground">Field editor</p>
        <h3 className="text-sm font-semibold">{heading}</h3>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`field-${field.id}`}>
          {isName ? "Signer full legal name" : isDate ? "Signing date" : "Value"}
        </Label>
        <Input
          id={`field-${field.id}`}
          value={textValue}
          onChange={(event) => {
            const next = field.field_type === "initials" ? event.target.value.toUpperCase().slice(0, 8) : event.target.value
            setTextValue(next)
          }}
          type={isDate ? "date" : "text"}
          placeholder={
            isName
              ? "Jane Doe"
              : field.field_type === "initials"
                ? "JD"
                : "Enter value"
          }
        />
      </div>

      {isDate ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CalendarDays className="h-3.5 w-3.5" />
          Date defaults to today and remains editable.
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={() => onApply(textValue, { advance: true, updateSignerName: isName })}
        >
          <Check className="mr-1.5 h-4 w-4" />
          Apply
        </Button>
      </div>
    </div>
  )
}
