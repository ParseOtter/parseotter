import { Component, type ErrorInfo, type ReactNode } from 'react'

type ErrorBoundaryProps = {
  children: ReactNode
}

type ErrorBoundaryState = {
  hasError: boolean
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    if (import.meta.env.DEV) {
      console.error('Unhandled application error', error, errorInfo)
    }
  }

  private reloadPage = (): void => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="page-shell">
          <section className="work-panel" role="alert" aria-labelledby="app-error-title">
            <div className="section-heading">
              <h1 id="app-error-title">Something went wrong</h1>
              <p>
                <span>The converter could not finish rendering.</span>
                <span>Reload the page and try again.</span>
              </p>
            </div>
            <button className="primary-button" type="button" onClick={this.reloadPage}>
              Reload
            </button>
          </section>
        </main>
      )
    }

    return this.props.children
  }
}
