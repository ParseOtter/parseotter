import { type ReactNode, useEffect, useRef } from 'react'

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

type DialogShellProps = {
  open: boolean
  onClose: () => void
  ariaLabel: string
  backdropClassName: string
  dialogClassName: string
  children: ReactNode
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

export function DialogShell({
  open,
  onClose,
  ariaLabel,
  backdropClassName,
  dialogClassName,
  children,
}: DialogShellProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    previousFocusRef.current = document.activeElement as HTMLElement | null

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose()
        return
      }

      if (event.key !== 'Tab' || !dialogRef.current) {
        return
      }

      const focusableElements = getFocusableElements(dialogRef.current)
      if (focusableElements.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }

      const first = focusableElements[0]
      const last = focusableElements[focusableElements.length - 1]

      if (event.shiftKey) {
        if (document.activeElement === first || document.activeElement === dialogRef.current) {
          event.preventDefault()
          last.focus()
        }
        return
      }

      if (document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    const dialogElement = dialogRef.current
    if (!dialogElement) {
      return () => {
        window.removeEventListener('keydown', handleKeyDown)
        previousFocusRef.current?.focus()
      }
    }

    const focusableElements = getFocusableElements(dialogElement)
    const initialFocusTarget = dialogElement.querySelector<HTMLElement>('[data-close-button]') ?? focusableElements[0] ?? dialogElement
    initialFocusTarget?.focus()

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      previousFocusRef.current?.focus()
    }
  }, [onClose, open])

  if (!open) {
    return null
  }

  return (
    <div
      className={backdropClassName}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <section
        ref={dialogRef}
        className={dialogClassName}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
      >
        {children}
      </section>
    </div>
  )
}
