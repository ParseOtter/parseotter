import { AlertCircle, CheckCircle2, Send, X } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { trackFeedbackOpened, trackFeedbackSubmitted } from '../analytics'
import {
  createParseOtterApiClient,
  ParseOtterApiError,
  type FeedbackCategory,
} from '../parseotter-api'
import { DialogShell } from './DialogShell'
import './FeedbackDialog.css'

const FEEDBACK_TOPICS: Array<{
  value: FeedbackCategory
  label: string
}> = [
  { value: 'conversion_quality', label: 'Conversion quality' },
  { value: 'performance', label: 'Speed' },
  { value: 'bug', label: 'Bug' },
  { value: 'feature_request', label: 'Feature request' },
  { value: 'other', label: 'Other' },
]

const RATING_OPTIONS = [1, 2, 3, 4, 5] as const

type SubmitState = 'idle' | 'submitting' | 'success' | 'error'

function readCurrentPageUrl(): string | null {
  return typeof window === 'undefined' ? null : window.location.href
}

export function FeedbackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useMemo(() => createParseOtterApiClient(), [])
  const [category, setCategory] = useState<FeedbackCategory>('conversion_quality')
  const [rating, setRating] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const [contact, setContact] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [submitState, setSubmitState] = useState<SubmitState>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const openRef = useRef(open)
  const submitSequenceRef = useRef(0)

  useEffect(() => {
    openRef.current = open
    if (!open) {
      submitSequenceRef.current += 1
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }

    trackFeedbackOpened()
  }, [open])

  const resetForm = useCallback((): void => {
    submitSequenceRef.current += 1
    setCategory('conversion_quality')
    setRating(null)
    setMessage('')
    setContact('')
    setCompanyName('')
    setSubmitState('idle')
    setErrorMessage('')
  }, [])

  const closeDialog = useCallback((): void => {
    resetForm()
    onClose()
  }, [onClose, resetForm])

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    const trimmedMessage = message.trim()
    if (trimmedMessage.length < 3) {
      setSubmitState('error')
      setErrorMessage('Add a little more detail before sending.')
      return
    }

    setSubmitState('submitting')
    setErrorMessage('')
    const submitSequence = submitSequenceRef.current + 1
    submitSequenceRef.current = submitSequence
    const isCurrentSubmit = () => submitSequenceRef.current === submitSequence && openRef.current

    try {
      await api.submitFeedback({
        category,
        rating,
        message: trimmedMessage,
        contact: contact.trim() || null,
        pageUrl: readCurrentPageUrl(),
        companyName,
      })
      if (!isCurrentSubmit()) {
        return
      }

      trackFeedbackSubmitted({ category, rating })
      setSubmitState('success')
      setMessage('')
      setContact('')
      setCompanyName('')
    } catch (error) {
      if (!isCurrentSubmit()) {
        return
      }

      setSubmitState('error')
      setErrorMessage(error instanceof ParseOtterApiError ? error.message : 'Feedback could not be sent. Please try again.')
    }
  }

  const isSubmitting = submitState === 'submitting'

  return (
    <DialogShell
      open={open}
      onClose={closeDialog}
      ariaLabel="Send feedback"
      backdropClassName="feedback-backdrop"
      dialogClassName="feedback-dialog"
    >
      <div className="feedback-header">
        <div>
          <h2 id="feedback-title">Send feedback</h2>
          <p>Help shape the first public version.</p>
        </div>
        <button className="icon-button" type="button" data-close-button aria-label="Close feedback" onClick={closeDialog}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      {submitState === 'success' ? (
        <div className="feedback-success" role="status">
          <CheckCircle2 size={28} aria-hidden="true" />
          <strong>Feedback received.</strong>
          <button className="secondary-button" type="button" onClick={closeDialog}>
            Close
          </button>
        </div>
      ) : (
        <form className="feedback-form" onSubmit={(event) => void handleSubmit(event)}>
          <label className="feedback-field" htmlFor="feedback-topic">
            <span>Topic</span>
            <select
              id="feedback-topic"
              value={category}
              onChange={(event) => setCategory(event.currentTarget.value as FeedbackCategory)}
            >
              {FEEDBACK_TOPICS.map((topic) => (
                <option key={topic.value} value={topic.value}>
                  {topic.label}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="feedback-rating">
            <legend>Overall</legend>
            <div className="feedback-rating-options">
              {RATING_OPTIONS.map((value) => (
                <label key={value} className="feedback-rating-option">
                  <input
                    type="radio"
                    name="feedback-rating"
                    value={value}
                    checked={rating === value}
                    onChange={() => setRating(value)}
                  />
                  <span>{value}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="feedback-field" htmlFor="feedback-message">
            <span>Message</span>
            <textarea
              id="feedback-message"
              value={message}
              maxLength={2000}
              rows={5}
              required
              onChange={(event) => setMessage(event.currentTarget.value)}
            />
          </label>

          <label className="feedback-field" htmlFor="feedback-contact">
            <span>Contact (optional)</span>
            <input
              id="feedback-contact"
              value={contact}
              maxLength={200}
              type="text"
              autoComplete="email"
              onChange={(event) => setContact(event.currentTarget.value)}
            />
          </label>

          <label className="feedback-honeypot" aria-hidden="true">
            Company
            <input
              tabIndex={-1}
              value={companyName}
              autoComplete="off"
              onChange={(event) => setCompanyName(event.currentTarget.value)}
            />
          </label>

          {submitState === 'error' ? (
            <p className="feedback-error" role="alert">
              <AlertCircle size={15} aria-hidden="true" />
              <span>{errorMessage}</span>
            </p>
          ) : null}

          <div className="feedback-actions">
            <button className="secondary-button" type="button" onClick={closeDialog}>
              Cancel
            </button>
            <button className="primary-button" type="submit" disabled={isSubmitting || message.trim().length < 3}>
              <Send size={15} aria-hidden="true" />
              {isSubmitting ? 'Sending' : 'Send feedback'}
            </button>
          </div>
        </form>
      )}
    </DialogShell>
  )
}
