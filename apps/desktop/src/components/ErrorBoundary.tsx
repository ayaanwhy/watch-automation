import { Component, type ReactNode, type ErrorInfo } from 'react'
import styles from './ErrorBoundary.module.css'

interface Props {
  onBack(): void
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className={styles.container}>
          <div className={styles.message}>Something went wrong in the workspace.</div>
          <div className={styles.detail}>{this.state.error.message}</div>
          <button className={styles.button} onClick={this.props.onBack}>
            Return to Batch Setup
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
