import { FileText } from "@/components/icons"
import { Progress } from "@/components/ui/progress"

interface SigningHeaderProps {
  title: string
  completedRequired: number
  totalRequired: number
}

export function SigningHeader({
  title,
  completedRequired,
  totalRequired,
}: SigningHeaderProps) {
  const progressPercent = totalRequired > 0 ? Math.round((completedRequired / totalRequired) * 100) : 100

  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto w-full max-w-7xl px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <h1 className="truncate text-base font-semibold sm:text-lg">E-sign document: {title}</h1>
          </div>

          <div className="w-full max-w-56 space-y-1">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>
                Required progress: {completedRequired}/{totalRequired || 0}
              </span>
            </div>
            <Progress value={progressPercent} className="h-2" />
          </div>
        </div>
      </div>
    </header>
  )
}
