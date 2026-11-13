import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from '../ui/Button';
import { EmptyState } from '../ui/Misc';

interface State {
  error: Error | undefined;
}

/** Keeps a render crash inside the page area so the sidebar stays usable. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: undefined };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Console render error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className='detail-placeholder'>
        <EmptyState
          icon='alert'
          title='This page crashed'
          action={<Button onClick={() => this.setState({ error: undefined })}>Try again</Button>}
        >
          {this.state.error.message}
        </EmptyState>
      </div>
    );
  }
}
