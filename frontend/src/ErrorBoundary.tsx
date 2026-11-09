import { Component, type ErrorInfo, type ReactNode } from "react";

/** Shows a readable message instead of a blank page if a component crashes. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ui] crashed:", error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="center-card">
        <p role="alert">画面の表示中にエラーが発生しました。ページを再読み込みしてください。<br />Something went wrong. Please reload the page.</p>
        <button type="button" onClick={() => window.location.reload()}>再読み込み / Reload</button>
      </div>
    );
  }
}
