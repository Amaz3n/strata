"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Input } from "@/components/ui/input"
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command"
import { cn } from "@/lib/utils"

interface GooglePlacesAutocompleteProps {
  value?: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

interface PlacePrediction {
  description: string
  place_id: string
  structured_formatting: {
    main_text: string
    secondary_text: string
  }
}

export function GooglePlacesAutocomplete({
  value = "",
  onChange,
  placeholder = "Enter address...",
  className
}: GooglePlacesAutocompleteProps) {
  const [inputValue, setInputValue] = useState(value)
  const [predictions, setPredictions] = useState<PlacePrediction[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const autocompleteServiceRef = useRef<google.maps.places.AutocompleteService | null>(null)

  // Initialize Google Places Autocomplete service
  useEffect(() => {
    if (typeof window !== 'undefined' && window.google && window.google.maps && window.google.maps.places) {
      autocompleteServiceRef.current = new window.google.maps.places.AutocompleteService()
    }
  }, [])

  // Reset selected index when predictions change
  useEffect(() => {
    setSelectedIndex(-1)
  }, [predictions])

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIndex >= 0 && listRef.current) {
      const selectedItem = listRef.current.children[selectedIndex] as HTMLElement
      if (selectedItem) {
        selectedItem.scrollIntoView({
          block: 'nearest',
          behavior: 'smooth'
        })
      }
    }
  }, [selectedIndex])

  // Handle click outside and keyboard events
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setPredictions([])
        setSelectedIndex(-1)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (predictions.length === 0) return

      if (event.key === 'Escape') {
        setPredictions([])
        setSelectedIndex(-1)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedIndex(prev => prev < predictions.length - 1 ? prev + 1 : 0)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedIndex(prev => prev > 0 ? prev - 1 : predictions.length - 1)
      } else if (event.key === 'Enter' && selectedIndex >= 0) {
        event.preventDefault()
        handleSelectPrediction(predictions[selectedIndex])
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [predictions, selectedIndex])

  // Update input value when prop changes
  useEffect(() => {
    setInputValue(value)
  }, [value])

  // Fetch predictions when input changes
  useEffect(() => {
    const fetchPredictions = async () => {
      if (!autocompleteServiceRef.current || inputValue.length < 3) {
        setPredictions([])
        setIsOpen(false)
        return
      }

      setIsLoading(true)
      try {
        const request = {
          input: inputValue,
          componentRestrictions: { country: 'us' },
          types: ['address']
        }

        autocompleteServiceRef.current.getPlacePredictions(request, (predictions, status) => {
        if (status === google.maps.places.PlacesServiceStatus.OK && predictions) {
          setPredictions(predictions)
        } else {
          setPredictions([])
        }
          setIsLoading(false)
        })
      } catch (error) {
        console.error('Error fetching place predictions:', error)
        setPredictions([])
        setIsLoading(false)
      }
    }

    const timeoutId = setTimeout(fetchPredictions, 300) // Debounce
    return () => clearTimeout(timeoutId)
  }, [inputValue])

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    setInputValue(newValue)
    onChange(newValue)
  }

  const handleSelectPrediction = (prediction: PlacePrediction) => {
    setInputValue(prediction.description)
    onChange(prediction.description)
    inputRef.current?.blur()
  }

  const handleInputFocus = () => {
    // Dropdown will show automatically when predictions exist
  }

  const handleInputBlur = () => {
    // Dropdown will hide automatically when input loses focus
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <Input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={handleInputChange}
        onFocus={handleInputFocus}
        onBlur={handleInputBlur}
        placeholder={placeholder}
        className={cn("w-full", className)}
        autoComplete="off"
      />
      {predictions.length > 0 && (
        <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-popover border border-border shadow-md">
          <Command className="w-full">
            <CommandList ref={listRef} className="max-h-60">
              <CommandGroup>
                {predictions.map((prediction, index) => (
                  <CommandItem
                    key={prediction.place_id}
                    value={prediction.place_id}
                    onSelect={() => handleSelectPrediction(prediction)}
                    className={cn(
                      "cursor-pointer px-3 py-2",
                      index === selectedIndex
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent"
                    )}
                  >
                    <span>
                      {prediction.structured_formatting.main_text}, {prediction.structured_formatting.secondary_text}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  )
}
