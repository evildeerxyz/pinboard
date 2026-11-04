import { useCallback, useState } from 'react';

/** Everything Settings changes, kept on this Mac. */
export type Settings = {
  /** Leave out code projects (Developer, any folder with package.json, .git…). */
  skipCode: boolean;
  /** Leave out icons, sprites and other pictures too small to look at. */
  skipSmall: boolean;
  /** Folders (inside the home folder) hidden from Pinboard. */
  hidden: string[];
  /** Put frames from video folders in All Photos too. */
  framesInAll: boolean;
  /** How wide the cards are. */
  cardSize: 's' | 'm' | 'l';
  /** Like and Show on a card when you point at it. */
  hoverActions: boolean;
  /** The strip of nearby photos at the foot of the viewer. */
  filmstrip: boolean;
  /** How sharp a photo is in the viewer: 1024 or 2048 pixels on its long side. */
  quality: 'fast' | 'sharp';
  /** When to look for new pictures on its own. */
  rescan: 'return' | 'hourly' | 'manual';
};

export const DEFAULTS: Settings = {
  skipCode: true,
  skipSmall: true,
  hidden: [],
  framesInAll: false,
  cardSize: 'm',
  hoverActions: true,
  filmstrip: true,
  quality: 'sharp',
  rescan: 'return',
};

/** The width a column aims for, by card size. */
export const COLUMN_WIDTH: Record<Settings['cardSize'], number> = { s: 190, m: 250, l: 330 };
/** How long after the last look it looks again on its own (Infinity: only when you ask). */
export const RESCAN_AFTER: Record<Settings['rescan'], number> = { return: 10 * 60_000, hourly: 60 * 60_000, manual: Infinity };

const KEY = 'settings';

function load(): Settings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>) };
  } catch {
    return DEFAULTS;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load);
  /** A change, or a function of what's set now (for changes made from somewhere that may be stale). */
  const update = useCallback((patch: Partial<Settings> | ((now: Settings) => Partial<Settings>)) => {
    setSettings((now) => {
      const next = { ...now, ...(typeof patch === 'function' ? patch(now) : patch) };
      localStorage.setItem(KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const reset = useCallback(() => {
    localStorage.setItem(KEY, JSON.stringify(DEFAULTS));
    setSettings(DEFAULTS);
  }, []);
  return [settings, update, reset] as const;
}
