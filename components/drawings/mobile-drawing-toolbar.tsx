'use client'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  ChevronLeft,
  ChevronRight,
  MapPin,
  Pencil,
  Camera,
  MoreVertical,
  Download,
  Share2,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface MobileDrawingToolbarProps {
  onPrevious?: () => void
  onNext?: () => void
  onDropPin: () => void
  onMarkup: () => void
  onCamera: () => void
  onDownload?: () => void
  onShare?: () => void
  isMarkupActive?: boolean
  className?: string
}

export function MobileDrawingToolbar({
  onPrevious,
  onNext,
  onDropPin,
  onMarkup,
  onCamera,
  onDownload,
  onShare,
  isMarkupActive = false,
  className,
}: MobileDrawingToolbarProps) {
  const hasPrevious = !!onPrevious
  const hasNext = !!onNext
  return (
    <div
      className={cn(
        'fixed bottom-0 left-0 right-0 z-50',
        'bg-background/95 backdrop-blur border-t',
        'px-4 py-3 flex items-center justify-around',
        'pb-[calc(0.75rem+env(safe-area-inset-bottom))]', // iOS safe area
        className
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        onClick={onPrevious}
        disabled={!hasPrevious}
        className="h-12 w-12"
      >
        <ChevronLeft className="h-6 w-6" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        onClick={onDropPin}
        className="h-12 w-12"
      >
        <MapPin className="h-6 w-6" />
      </Button>

      <Button
        variant={isMarkupActive ? 'secondary' : 'ghost'}
        size="icon"
        onClick={onMarkup}
        className="h-12 w-12"
      >
        <Pencil className="h-6 w-6" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        onClick={onCamera}
        className="h-12 w-12"
      >
        <Camera className="h-6 w-6" />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-12 w-12">
            <MoreVertical className="h-6 w-6" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={onDownload}>
            <Download className="h-4 w-4 mr-2" />
            Download PDF
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onShare}>
            <Share2 className="h-4 w-4 mr-2" />
            Share Sheet
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant="ghost"
        size="icon"
        onClick={onNext}
        disabled={!hasNext}
        className="h-12 w-12"
      >
        <ChevronRight className="h-6 w-6" />
      </Button>
    </div>
  )
}
