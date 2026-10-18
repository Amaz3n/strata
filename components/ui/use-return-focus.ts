import * as React from 'react'

type AutoFocusHandlers = {
  onOpenAutoFocus?: (event: Event) => void
  onCloseAutoFocus?: (event: Event) => void
}

/**
 * Radix returns focus to a `Trigger` when a dialog closes. Most of Arc's sheets and
 * dialogs are opened from state by an ordinary button, with no trigger, and closing them
 * dropped keyboard focus on the page body. This remembers what had focus when the
 * surface opened and goes back to it, unless the caller handled it or the element is gone.
 */
export function useReturnFocus({ onOpenAutoFocus, onCloseAutoFocus }: AutoFocusHandlers): Required<AutoFocusHandlers> {
  const opener = React.useRef<HTMLElement | null>(null)
  return {
    onOpenAutoFocus: (event) => {
      const active = document.activeElement
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null
      onOpenAutoFocus?.(event)
    },
    onCloseAutoFocus: (event) => {
      onCloseAutoFocus?.(event)
      const element = opener.current
      opener.current = null
      if (event.defaultPrevented || !element?.isConnected) return
      event.preventDefault()
      element.focus()
    },
  }
}
