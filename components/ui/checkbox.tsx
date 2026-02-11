'use client'

import * as React from 'react'
import { CheckIcon, MinusIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

type CheckedState = boolean | 'indeterminate'

type CheckboxProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'checked' | 'defaultChecked' | 'onChange' | 'type'
> & {
  checked?: CheckedState
  defaultChecked?: CheckedState
  onCheckedChange?: (checked: CheckedState) => void
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, checked, defaultChecked, onCheckedChange, disabled, onClick, ...props },
  ref
) {
  const isControlled = checked !== undefined
  const [internalChecked, setInternalChecked] = React.useState<CheckedState>(
    defaultChecked ?? false
  )

  const resolvedChecked = isControlled ? checked : internalChecked
  const isIndeterminate = resolvedChecked === 'indeterminate'
  const isChecked = resolvedChecked === true

  const handleChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const nextChecked = event.currentTarget.checked
      if (!isControlled) {
        setInternalChecked(nextChecked)
      }
      onCheckedChange?.(nextChecked)
    },
    [isControlled, onCheckedChange]
  )

  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLInputElement>) => {
      if (isIndeterminate) {
        event.preventDefault()
        const nextChecked = true
        if (!isControlled) {
          setInternalChecked(nextChecked)
        }
        onCheckedChange?.(nextChecked)
      }
      onClick?.(event)
    },
    [isIndeterminate, isControlled, onCheckedChange, onClick]
  )

  return (
    <span className="relative inline-flex items-center justify-center">
      <input
        {...props}
        ref={ref}
        type="checkbox"
        checked={isChecked}
        aria-checked={isIndeterminate ? 'mixed' : isChecked}
        data-slot="checkbox"
        data-state={isIndeterminate ? 'indeterminate' : isChecked ? 'checked' : 'unchecked'}
        disabled={disabled}
        onChange={handleChange}
        onClick={handleClick}
        className={cn(
          'peer border-input dark:bg-input/30 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:data-[state=checked]:bg-primary data-[state=checked]:border-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive size-4 shrink-0 rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 appearance-none',
          isChecked && 'bg-primary border-primary text-primary-foreground',
          isIndeterminate && 'bg-primary border-primary text-primary-foreground',
          className
        )}
      />
      <span
        data-slot="checkbox-indicator"
        className={cn(
          'pointer-events-none absolute inset-0 flex items-center justify-center text-current transition-none',
          isChecked || isIndeterminate ? 'opacity-100' : 'opacity-0',
          disabled && 'opacity-50'
        )}
      >
        {isIndeterminate ? (
          <MinusIcon className="size-3.5" />
        ) : (
          <CheckIcon className="size-3.5" />
        )}
      </span>
    </span>
  )
})

Checkbox.displayName = 'Checkbox'

export { Checkbox }
