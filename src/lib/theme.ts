import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect } from 'react';

/** Light, dark, or whatever the Mac is set to (System Settings › Appearance). */
export type ThemeChoice = 'auto' | 'light' | 'dark';

const darkMedia = () => matchMedia('(prefers-color-scheme: dark)');

/** Puts the page in light or dark: the class and data-theme that Pinboard's and basedraft's
 * colors follow. */
export function applyTheme(choice: ThemeChoice) {
  const dark = choice === 'dark' || (choice === 'auto' && darkMedia().matches);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.classList.toggle('light', !dark);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
}

/** Keeps the page, and macOS's own parts of the window (the see-through sidebar, the traffic
 * lights), in the chosen appearance, following the Mac when it's Auto. */
export function useTheme(choice: ThemeChoice) {
  useEffect(() => {
    applyTheme(choice);
    try {
      void getCurrentWindow()
        .setTheme(choice === 'auto' ? null : choice)
        .catch(() => {});
    } catch {
      // Not in the app (a browser preview): the page alone follows.
    }
    if (choice !== 'auto') return;
    const media = darkMedia();
    const follow = () => applyTheme('auto');
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, [choice]);
}
