import { ArrowLeft, ArrowRight, CheckCircle2 } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { normalizeFieldLabel, type SigningField } from "./types"

interface FieldNavigatorProps {
  activeField: SigningField | null
  currentIndex: number
  totalFields: number
  canGoPrevious: boolean
  canGoNext: boolean
  allRequiredComplete: boolean
  onPrevious: () => void
  onNext: () => void
  onFinish: () => void
}

export function FieldNavigator({
  activeField,
  currentIndex,
  totalFields,
  canGoPrevious,
  canGoNext,
  allRequiredComplete,
  onPrevious,
  onNext,
  onFinish,
}: FieldNavigatorProps) {
  const isLast = totalFields > 0 && currentIndex >= totalFields - 1
  const showFinish = allRequiredComplete || totalFields === 0 || isLast

  return (
    <footer className="sticky bottom-0 z-30 border-t bg-background/95 px-3 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60 sm:px-4">
      <div className="mx-auto flex w-full max-w-4xl items-center gap-2 sm:gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={onPrevious}
          disabled={!canGoPrevious}
        >
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Previous
        </Button>

        <div className="min-w-0 flex-1 rounded-md border bg-muted/40 px-3 py-2 text-center">
          {activeField ? (
            <div className="truncate text-sm font-medium">
              {normalizeFieldLabel(activeField)}
              <span className={cn("ml-2 text-xs", activeField.required === false ? "text-muted-foreground" : "text-destructive")}>
                {activeField.required === false ? "Optional" : "Required"}
              </span>
            </div>
          ) : (
            <div className="text-sm font-medium text-muted-foreground">No fields assigned to this signer</div>
          )}
          {totalFields > 0 ? (
            <div className="text-[11px] text-muted-foreground">
              Field {currentIndex + 1} of {totalFields}
            </div>
          ) : null}
        </div>

        {showFinish ? (
          <Button
            type="button"
            onClick={onFinish}
            disabled={!allRequiredComplete}
          >
            <CheckCircle2 className="mr-1.5 h-4 w-4" />
            Finish
          </Button>
        ) : (
          <Button
            type="button"
            onClick={onNext}
            disabled={!canGoNext}
          >
            Next
            <ArrowRight className="ml-1.5 h-4 w-4" />
          </Button>
        )}
      </div>
    </footer>
  )
}
