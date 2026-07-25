"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"

import { Check, Eye, EyeOff } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { SettingsError, SettingsField } from "@/components/settings/settings-section"
import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"

const MIN_LENGTH = 8

type Strength = {
  score: number // 0–4 filled segments
  label: string
  tone: "muted" | "destructive" | "warning" | "success"
}

/** Advisory only — the sole hard rule is the {MIN_LENGTH}-char minimum below. */
function scorePassword(value: string): Strength {
  if (!value) return { score: 0, label: "", tone: "muted" }

  let raw = 0
  if (value.length >= MIN_LENGTH) raw++
  if (value.length >= 12) raw++
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) raw++
  if (/\d/.test(value)) raw++
  if (/[^A-Za-z0-9]/.test(value)) raw++
  const score = Math.min(raw, 4)

  if (value.length < MIN_LENGTH) return { score: 1, label: "Too short", tone: "destructive" }
  if (score <= 2) return { score: 2, label: "Weak", tone: "warning" }
  if (score === 3) return { score: 3, label: "Good", tone: "warning" }
  return { score: 4, label: "Strong", tone: "success" }
}

const TONE_FILL: Record<Strength["tone"], string> = {
  muted: "bg-border",
  destructive: "bg-destructive",
  warning: "bg-warning",
  success: "bg-success",
}

const TONE_TEXT: Record<Strength["tone"], string> = {
  muted: "text-muted-foreground",
  destructive: "text-destructive",
  warning: "text-warning",
  success: "text-success",
}

function Requirement({ met, children }: { met: boolean; children: React.ReactNode }) {
  return (
    <li
      className={cn(
        "flex items-center gap-1.5 text-xs transition-colors",
        met ? "text-success" : "text-muted-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center border transition-colors",
          met ? "border-success/40 bg-success/10" : "border-border",
        )}
      >
        {met ? <Check className="size-3" /> : null}
      </span>
      {children}
      <span className="sr-only">{met ? "— met" : "— not met"}</span>
    </li>
  )
}

export function PasswordField() {
  const supabase = useMemo(() => createClient(), [])
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [reveal, setReveal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const strength = scorePassword(password)
  const longEnough = password.length >= MIN_LENGTH
  const matches = confirm.length > 0 && password === confirm
  const canSubmit = longEnough && matches && !saving

  const reset = () => {
    setPassword("")
    setConfirm("")
    setReveal(false)
    setError(null)
    setSaving(false)
  }

  const handleOpenChange = (next: boolean) => {
    if (saving) return
    setOpen(next)
    if (!next) reset()
  }

  const submit = async () => {
    if (!longEnough) {
      setError(`Use at least ${MIN_LENGTH} characters.`)
      return
    }
    if (!matches) {
      setError("Those passwords don't match.")
      return
    }

    setSaving(true)
    setError(null)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setSaving(false)

    if (updateError) {
      setError(updateError.message)
      return
    }

    setOpen(false)
    reset()
    toast.success("Password updated")
  }

  return (
    <SettingsField label="Password" hint="Protects your account when you sign in.">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span aria-hidden className="text-sm tracking-[0.3em] text-muted-foreground">
          ••••••••
        </span>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Change password
        </Button>
      </div>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>
              You&rsquo;ll stay signed in on this device. Other devices keep their sessions until you sign them out.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="new-password" className="microlabel">
                New password
              </label>
              <div className="relative">
                <Input
                  id="new-password"
                  type={reveal ? "text" : "password"}
                  autoComplete="new-password"
                  autoFocus
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value)
                    setError(null)
                  }}
                  className="h-9 pr-9"
                  disabled={saving}
                />
                <button
                  type="button"
                  onClick={() => setReveal((prev) => !prev)}
                  aria-label={reveal ? "Hide password" : "Show password"}
                  title={reveal ? "Hide password" : "Show password"}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                >
                  {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>

              <div className="flex items-center gap-3 pt-0.5" aria-hidden={!password}>
                <div className="flex h-1 flex-1 gap-1">
                  {[0, 1, 2, 3].map((segment) => (
                    <span
                      key={segment}
                      className={cn(
                        "flex-1 transition-colors",
                        segment < strength.score ? TONE_FILL[strength.tone] : "bg-border",
                      )}
                    />
                  ))}
                </div>
                <span
                  className={cn(
                    "w-16 shrink-0 whitespace-nowrap text-right text-xs tabular-nums",
                    TONE_TEXT[strength.tone],
                  )}
                >
                  {strength.label}
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="confirm-password" className="microlabel">
                Confirm password
              </label>
              <Input
                id="confirm-password"
                type={reveal ? "text" : "password"}
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => {
                  setConfirm(event.target.value)
                  setError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canSubmit) void submit()
                }}
                className="h-9"
                disabled={saving}
              />
            </div>

            <ul className="space-y-1.5">
              <Requirement met={longEnough}>At least {MIN_LENGTH} characters</Requirement>
              <Requirement met={matches}>Both entries match</Requirement>
            </ul>

            {error ? <SettingsError>{error}</SettingsError> : null}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={!canSubmit}>
              {saving ? "Updating…" : "Update password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsField>
  )
}
