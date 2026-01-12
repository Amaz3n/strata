'use client'

import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import {
  MapPin,
  Wrench,
  HelpCircle,
  AlertCircle,
  Camera,
  Ruler,
} from 'lucide-react'

interface LongPressMenuProps {
  open: boolean
  position: { x: number; y: number } // Screen coordinates
  onClose: () => void
  onAction?: (action: string) => void
  // Individual handlers (optional, used if onAction is not provided)
  onDropPin?: () => void
  onCreateTask?: () => void
  onCreateRFI?: () => void
  onCreatePunch?: () => void
  onAttachPhoto?: () => void
  onMeasure?: () => void
}

export function LongPressMenu({
  open,
  position,
  onClose,
  onAction,
  onDropPin,
  onCreateTask,
  onCreateRFI,
  onCreatePunch,
  onAttachPhoto,
  onMeasure,
}: LongPressMenuProps) {
  // Helper to handle action - uses onAction if provided, otherwise individual handler
  const handleAction = (action: string, handler?: () => void) => {
    if (onAction) {
      onAction(action)
    } else if (handler) {
      handler()
    }
    onClose()
  }
  const menuRef = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return

    const handleClick = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    // Use a short delay to prevent immediate close from the same tap
    const timeout = setTimeout(() => {
      document.addEventListener('click', handleClick)
      document.addEventListener('touchstart', handleClick)
    }, 100)

    return () => {
      clearTimeout(timeout)
      document.removeEventListener('click', handleClick)
      document.removeEventListener('touchstart', handleClick)
    }
  }, [open, onClose])

  // Close on escape
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  // Position menu, ensuring it stays on screen
  const menuWidth = 220
  const menuHeight = 300
  const padding = 16

  const left = Math.min(
    Math.max(padding, position.x - menuWidth / 2),
    window.innerWidth - menuWidth - padding
  )
  const top = Math.min(
    Math.max(padding, position.y + 10), // Offset below touch point
    window.innerHeight - menuHeight - padding
  )

  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left,
    top,
    zIndex: 100,
  }

  const items = [
    { icon: MapPin, label: 'Drop Pin', action: 'drop-pin', handler: onDropPin },
    { icon: Wrench, label: 'New Task', action: 'new-task', handler: onCreateTask },
    { icon: HelpCircle, label: 'New RFI', action: 'new-rfi', handler: onCreateRFI },
    { icon: AlertCircle, label: 'New Punch Item', action: 'new-punch', handler: onCreatePunch },
    { divider: true },
    { icon: Camera, label: 'Attach Photo', action: 'attach-photo', handler: onAttachPhoto },
    { icon: Ruler, label: 'Add Measurement', action: 'add-measurement', handler: onMeasure },
  ] as const

  return (
    <div
      ref={menuRef}
      style={menuStyle}
      className={cn(
        'bg-popover border rounded-lg shadow-lg overflow-hidden',
        'animate-in fade-in-0 zoom-in-95 duration-200'
      )}
    >
      <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b">
        Create at this location
      </div>
      <div className="py-1">
        {items.map((item, i) =>
          'divider' in item ? (
            <div key={i} className="border-t my-1" />
          ) : (
            <button
              key={i}
              onClick={() => handleAction(item.action, item.handler)}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2.5 text-sm',
                'hover:bg-muted transition-colors text-left'
              )}
            >
              <item.icon className="h-4 w-4 text-muted-foreground" />
              {item.label}
            </button>
          )
        )}
      </div>
    </div>
  )
}
