"use client"

import { useId, useRef, useState, type ReactNode } from "react"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { X } from "@/components/icons"
import { cn } from "@/lib/utils"
import type { PrequalificationQuestion } from "@/lib/validation/prequalification"

export type AnswerValue = string | number | boolean | null

/**
 * One labelled control. Everything in this form goes through it so label,
 * control, hint and error keep the same rhythm — the bare `Label` has
 * `leading-none` and no margin, which is what made the old form's headings sit
 * on top of their inputs.
 */
export function Field({
  label,
  htmlFor,
  required,
  hint,
  error,
  className,
  children,
}: {
  label: string
  htmlFor?: string
  required?: boolean
  hint?: string
  error?: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Label htmlFor={htmlFor} className="leading-snug">
          {label}
        </Label>
        {required ? null : (
          <span className="text-xs text-muted-foreground">Optional</span>
        )}
      </div>
      {children}
      {error ? (
        <p className="text-xs font-medium text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}

const CONTROL_HEIGHT = "h-11"

/** Digits with thousands separators, so a seven-figure revenue stays readable. */
function groupDigits(raw: string): string {
  const digits = raw.replace(/[^\d.]/g, "")
  const [whole, ...rest] = digits.split(".")
  const grouped = whole ? Number(whole).toLocaleString("en-US") : ""
  return rest.length > 0 ? `${grouped}.${rest.join("").slice(0, 2)}` : grouped
}

export function MoneyInput({
  id,
  value,
  onChange,
  invalid,
  placeholder,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  invalid?: boolean
  placeholder?: string
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
        $
      </span>
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(groupDigits(event.target.value))}
        className={cn(CONTROL_HEIGHT, "pl-7 tabular-nums", invalid && "border-destructive")}
      />
    </div>
  )
}

export function PlainInput({
  id,
  value,
  onChange,
  invalid,
  placeholder,
  inputMode,
  type,
  suffix,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  invalid?: boolean
  placeholder?: string
  inputMode?: "numeric" | "decimal" | "text" | "email" | "tel"
  type?: string
  suffix?: string
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        type={type}
        inputMode={inputMode}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          CONTROL_HEIGHT,
          inputMode === "numeric" || inputMode === "decimal" ? "tabular-nums" : null,
          suffix && "pr-16",
          invalid && "border-destructive",
        )}
      />
      {suffix ? (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          {suffix}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Yes/no as two real targets. A lone checkbox reads as "check if true", which
 * is ambiguous on a question like "any open litigation?" and leaves no way to
 * tell a deliberate no from an unanswered one.
 */
export function YesNoControl({
  id,
  value,
  onChange,
  invalid,
}: {
  id: string
  value: boolean | null
  onChange: (value: boolean) => void
  invalid?: boolean
}) {
  return (
    <div
      id={id}
      role="radiogroup"
      className={cn(
        "grid max-w-xs grid-cols-2 gap-2",
        invalid && "[&>button]:border-destructive",
      )}
    >
      {[
        { label: "Yes", selected: value === true, next: true },
        { label: "No", selected: value === false, next: false },
      ].map((option) => (
        <button
          key={option.label}
          type="button"
          role="radio"
          aria-checked={option.selected}
          onClick={() => onChange(option.next)}
          className={cn(
            CONTROL_HEIGHT,
            "border text-sm font-medium transition-colors",
            option.selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-input bg-background text-foreground hover:bg-muted",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Trades as removable chips. The old form asked for a comma-separated string,
 * which meant a vendor could not see what they had actually entered and a
 * stray comma silently split a trade in two.
 */
export function ChipInput({
  id,
  values,
  onChange,
  placeholder,
  invalid,
}: {
  id: string
  values: string[]
  onChange: (values: string[]) => void
  placeholder?: string
  invalid?: boolean
}) {
  const [draft, setDraft] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const commit = (raw: string) => {
    const parts = raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
    if (parts.length === 0) return
    const next = [...values]
    for (const part of parts) {
      if (!next.some((existing) => existing.toLowerCase() === part.toLowerCase())) next.push(part)
    }
    onChange(next)
    setDraft("")
  }

  return (
    <div
      className={cn(
        "flex min-h-11 flex-wrap items-center gap-1.5 border bg-background p-1.5 focus-within:border-ring",
        invalid ? "border-destructive" : "border-input",
      )}
      onClick={() => inputRef.current?.focus()}
    >
      {values.map((value) => (
        <span
          key={value}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-muted py-1 pl-3 pr-1.5 text-xs font-medium"
        >
          {value}
          <button
            type="button"
            aria-label={`Remove ${value}`}
            className="text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation()
              onChange(values.filter((item) => item !== value))
            }}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        id={id}
        value={draft}
        placeholder={values.length === 0 ? placeholder : "Add another…"}
        className="min-w-[8rem] flex-1 bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
        onChange={(event) => {
          if (event.target.value.includes(",")) commit(event.target.value)
          else setDraft(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            commit(draft)
          }
          if (event.key === "Backspace" && !draft && values.length > 0) {
            onChange(values.slice(0, -1))
          }
        }}
        onBlur={() => commit(draft)}
      />
    </div>
  )
}

export function QuestionField({
  question,
  value,
  onChange,
  error,
}: {
  question: PrequalificationQuestion
  value: AnswerValue
  onChange: (value: AnswerValue) => void
  error?: string
}) {
  const generatedId = useId()
  const id = `q-${question.id}-${generatedId}`
  const invalid = Boolean(error)

  return (
    <Field
      label={question.label}
      htmlFor={id}
      required={question.required}
      hint={question.help || undefined}
      error={error}
    >
      {question.type === "longtext" ? (
        <Textarea
          id={id}
          rows={4}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          className={cn("resize-y", invalid && "border-destructive")}
        />
      ) : question.type === "boolean" ? (
        <YesNoControl
          id={id}
          value={typeof value === "boolean" ? value : null}
          onChange={onChange}
          invalid={invalid}
        />
      ) : question.type === "select" ? (
        <Select
          value={typeof value === "string" ? value : ""}
          onValueChange={(next) => onChange(next)}
        >
          <SelectTrigger
            id={id}
            className={cn("!h-11 w-full max-w-sm", invalid && "border-destructive")}
          >
            <SelectValue placeholder="Choose one" />
          </SelectTrigger>
          <SelectContent>
            {question.options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : question.type === "money" ? (
        <MoneyInput
          id={id}
          value={value == null ? "" : String(value)}
          onChange={(next) => onChange(next === "" ? null : next)}
          invalid={invalid}
        />
      ) : (
        <PlainInput
          id={id}
          type={question.type === "date" ? "date" : "text"}
          inputMode={question.type === "number" ? "decimal" : undefined}
          value={value == null ? "" : String(value)}
          onChange={(next) => onChange(next === "" ? null : next)}
          invalid={invalid}
        />
      )}
    </Field>
  )
}
