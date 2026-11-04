import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadSettings } from './lib/settings';
import { applyTheme } from './lib/theme';
import './styles.css';

// Light or dark before anything is drawn, so the window never flashes the other one.
applyTheme(loadSettings().theme);

/** If something breaks while drawing, say so and offer a way back, instead of an empty window. */
class Fallback extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div data-tauri-drag-region className="grid h-full place-items-center p-10 text-center">
        <div className="max-w-[420px]">
          <p className="text-[17px] font-semibold text-ink">Something went wrong</p>
          <p className="mt-2 text-[14px] leading-relaxed text-ink/55">{this.state.error.message}</p>
          <button type="button" onClick={() => location.reload()} className="mt-5 h-9 rounded-full bg-ink px-5 text-[14px] font-medium text-panel">
            Reload Pinboard
          </button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Fallback>
      <App />
    </Fallback>
  </StrictMode>,
);
