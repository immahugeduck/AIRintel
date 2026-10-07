import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { failed: boolean };

/** Keep rendering failures visible rather than leaving an empty page. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };
  static getDerivedStateFromError(): State { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("AIRIntel rendering failed", error, info.componentStack); }
  render() {
    if (this.state.failed) return <section className="track-empty" role="alert">
      <h2>This view could not load</h2>
      <p>Reload the page to retry. Aircraft data has not been changed.</p>
      <button type="button" className="ghost-button" onClick={() => window.location.reload()}>Reload page</button>
    </section>;
    return this.props.children;
  }
}
