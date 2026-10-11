import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode; /** Sentence subject for the fallback, e.g. "The map". */ label?: string };
type State = { failed: boolean };

/**
 * Keep rendering failures visible and contained rather than leaving an empty page. Used around the whole app and
 * around each view / the map, so one failing panel never takes down navigation. Give it `key={view}` to reset on navigation.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };
  static getDerivedStateFromError(): State { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("AIRIntel rendering failed", error.name, info.componentStack); }
  render() {
    if (this.state.failed) return <section className="track-empty panel" role="alert">
      <h2>{this.props.label ?? "This view"} could not load</h2>
      <p>Aircraft data has not been changed. Try again, or reload the page.</p>
      <div className="preset-row">
        <button type="button" className="button button-ghost" onClick={() => this.setState({ failed: false })}>Try again</button>
        <button type="button" className="button button-ghost" onClick={() => window.location.reload()}>Reload page</button>
      </div>
    </section>;
    return this.props.children;
  }
}
