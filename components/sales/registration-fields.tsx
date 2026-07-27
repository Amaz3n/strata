"use client"

import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

/**
 * The registration card's own field furniture, shared by the card that creates a
 * lead and the sheet that corrects one, so the two forms are the same form.
 */

export function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3 px-5 py-4">
      <div>
        <h3 className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">{title}</h3>
        {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  )
}

export function Field({
  label,
  htmlFor,
  required,
  children,
}: {
  label: string
  htmlFor?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor} className="text-[11px] font-normal text-muted-foreground">
        {label}
        {required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </Label>
      {children}
    </div>
  )
}

const NONE = "__none"

/** A select that can be emptied — Radix cannot hold an empty-string item value. */
export function Picker({
  value,
  onChange,
  placeholder,
  options,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  options: { value: string; label: string }[]
  disabled?: boolean
}) {
  return (
    <Select
      value={value || NONE}
      onValueChange={(next) => onChange(next === NONE ? "" : next)}
      disabled={disabled}
    >
      <SelectTrigger className="!h-9 w-full rounded-none text-[13px]">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="rounded-none">
        <SelectItem value={NONE}>{placeholder}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Plain string list to picker options, for the closed vocabularies. */
export function labelOptions(values: string[]): { value: string; label: string }[] {
  return values.map((label) => ({ value: label, label }))
}
