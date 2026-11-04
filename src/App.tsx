import {
  ActionBar,
  ActionBarButton,
  Alert,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogIcon,
  DialogTitle,
  EmptyState,
  Toaster,
  toast,
} from '@basedraft/ui';
import {
  ArrowSquareOutIcon,
  CameraIcon,
  ChecksIcon,
  CopyIcon,
  ClockIcon,
  FileJpgIcon,
  FilePngIcon,
  FilmStripIcon,
  FolderOpenIcon,
  FolderSimpleIcon,
  HeartIcon,
  HouseSimpleIcon,
  ImagesSquareIcon,
  MagnifyingGlassIcon,
  MonitorIcon,
  GearSixIcon,
  GifIcon,
  RectangleIcon,
  SidebarSimpleIcon,
  SparkleIcon,
  SquareIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PhotoViewer, type ViewerPhoto } from './basedraft/photo-viewer';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import appIcon from './assets/app-icon.png';
import { FilterMenu, type FilterGroup } from './components/FilterMenu';
import { Masonry, MasonrySkeleton, type CardActions } from './components/Masonry';
import { Search } from './components/Search';
import { SettingsPage } from './components/SettingsPage';
import { Tip } from './components/Tip';
import { COLUMN_WIDTH, RESCAN_AFTER, useSettings } from './lib/settings';
import { useTheme } from './lib/theme';
import { Sidebar, type NavItem } from './components/Sidebar';
import { copyPhoto, copyPhotos, hideWindow, openPhoto, openPhotos, openPrivacySettings, putBack, reveal, revealPhotos, scanLibrary, takeOpened, thumbUrl, trashPhotos, type Photo } from './lib/api';
import { APP_NAME } from './lib/brand';
import { CATEGORIES, FILTERS, FILTER_GROUPS, classify, pictures, dateOf, flattenFolders, folderTree, inFolder, matches, sizeOf, type CategoryId, type Indexed } from './lib/library';

/** The sidebar folding away, and everything beside it making room, on one spring. */
const FOLD = { type: 'spring', stiffness: 380, damping: 40, mass: 0.9 } as const;

/** Each filter's icon, in the Filter menu. */
const FILTER_ICONS: Record<(typeof FILTERS)[number]['value'], ReactNode> = {
  portrait: <RectangleIcon className="rotate-90" />,
  landscape: <RectangleIcon />,
  square: <SquareIcon />,
  screenshots: <MonitorIcon />,
  camera: <CameraIcon />,
  gif: <GifIcon />,
  png: <FilePngIcon />,
  jpeg: <FileJpgIcon />,
};

/** How many pictures Surprise Me deals. */
const SURPRISE = 240;

function useFavorites() {
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('favorites') ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback((id: string) => {
    setFavorites((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      localStorage.setItem('favorites', JSON.stringify([...next]));
      return next;
    });
  }, []);
  /** Several at once: all on, or all off. */
  const setMany = useCallback((ids: string[], on: boolean) => {
    setFavorites((now) => {
      const next = new Set(now);
      for (const id of ids) if (on) next.add(id); else next.delete(id);
      localStorage.setItem('favorites', JSON.stringify([...next]));
      return next;
    });
  }, []);
  return [favorites, toggle, setMany] as const;
}

/** Opening more than this many at once is surely a slip. */
const OPEN_AT_MOST = 50;

const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/** A different handful each time (Fisher–Yates on a copy, stopping once there are enough). */
function deal<T>(items: T[], n: number): T[] {
  const a = items.slice();
  const take = Math.min(n, a.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, take);
}

export function App() {
  const [photos, setPhotos] = useState<Indexed[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Folders macOS didn't let Pinboard look in, and whether you've put the note about them away. */
  const [blocked, setBlocked] = useState<string[]>([]);
  const [blockedNoted, setBlockedNoted] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scannedAt, setScannedAt] = useState(0);
  const [active, setActive] = useState('all');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<string[]>([]);
  const [favorites, toggleFavorite, setFavorites] = useFavorites();
  /** The photos ticked for the action bar, and the one last ticked (where a Shift-click run starts). */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  /** The photos waiting on "Move to Trash?". */
  const [toTrash, setToTrash] = useState<Indexed[] | null>(null);
  /** The viewer: what it shows and where it starts. `key` is new for each picture opened from Finder,
   * so a viewer that's already open starts again on it rather than staying where it was. */
  const [viewer, setViewer] = useState<{ list: Indexed[]; start: number; key?: number } | null>(null);
  /** Showing a picture opened from Finder on its own, with no sidebar, the way Preview would. `back`
   * is where closing it goes: back to Pinboard as it was, or (if Pinboard was opened just for this
   * picture) putting the window away. */
  const [finder, setFinder] = useState<{ back: 'hide' | 'pinboard' } | null>(null);
  /** A photo for the grid to point out (after "See folder in Pinboard"). */
  const [pointAt, setPointAt] = useState<{ id: string; tick: number } | null>(null);
  const [palette, setPalette] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  /** Full screen hides the traffic lights, so the app's icon takes their place. */
  const [fullscreen, setFullscreen] = useState(false);
  const [hand, setHand] = useState(0);
  const [, tick] = useState(0);
  const [settings, update, reset] = useSettings();
  /** The latest settings, for a scan started from anywhere. */
  useTheme(settings.theme);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const search = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** The raised panel the photos (and the viewer) sit in. */
  const panel = useRef<HTMLElement>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const { skipCode, skipSmall } = settingsRef.current;
      const scan = await scanLibrary({ skipCode, skipSmall });
      setPhotos(classify(scan.photos));
      setBlocked(scan.blocked);
      setScannedAt(Date.now());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => void scan(), [scan]);

  // Back in the app after a while: ask Spotlight again (two seconds, no disk crawl). Keep "updated" fresh.
  useEffect(() => {
    const onFocus = () => {
      if (Date.now() - scannedAt > RESCAN_AFTER[settings.rescan] && !scanning) void scan();
      tick((n) => n + 1);
    };
    addEventListener('focus', onFocus);
    const timer = setInterval(() => tick((n) => n + 1), 60_000);
    return () => {
      removeEventListener('focus', onFocus);
      clearInterval(timer);
    };
  }, [scan, scannedAt, scanning, settings.rescan]);

  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      const win = getCurrentWindow();
      const check = () => void win.isFullscreen().then((f) => setFullscreen(!!f)).catch(() => {});
      check();
      void win.onResized(check).then((un) => (off = un)).catch(() => {});
    } catch {
      // Not in the app (a browser preview): no traffic lights to stand in for.
    }
    return () => off?.();
  }, []);

  useEffect(() => {
    if (settings.rescan !== 'hourly') return;
    const t = setInterval(() => void scan(), RESCAN_AFTER.hourly);
    return () => clearInterval(t);
  }, [settings.rescan, scan]);

  // ⌘, opens Settings, ⌘K searches everything, ⌘F the photos on screen, ⌘\ folds the sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === ',') {
        e.preventDefault();
        goRef.current('settings');
      } else if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((o) => !o);
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      } else if (e.key === '\\') {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // ⌘A ticks everything on screen, Escape unticks, ⌘⌫ moves what's ticked to the Trash (as in Finder).
  const selectionKeys = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => selectionKeys.current(e);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // Hidden folders (Settings) are left out of everything: views, sidebar, counts and search.
  const all = useMemo(() => {
    const list = photos ?? [];
    return settings.hidden.length ? list.filter((p) => !settings.hidden.some((h) => inFolder(p, h))) : list;
  }, [photos, settings.hidden]);
  const tree = useMemo(() => folderTree(all), [all]);
  const folders = useMemo(() => flattenFolders(tree), [tree]);
  const folder = active.startsWith('folder:') ? active.slice(7) : null;
  const category = CATEGORIES.find((c) => c.id === active) ?? CATEGORIES[0];

  const libraryCounts = useMemo(() => {
    const out = {} as Record<CategoryId, number>;
    const none = new Set<string>();
    for (const c of CATEGORIES) out[c.id] = 0;
    for (const p of all) for (const c of CATEGORIES) if (c.id !== 'favorites' && c.test(p, none)) out[c.id]++;
    return out;
  }, [all]);
  const favoriteCount = useMemo(() => all.filter((p) => favorites.has(p.id)).length, [all, favorites]);
  const counts = useMemo(() => ({ ...libraryCounts, favorites: favoriteCount }), [libraryCounts, favoriteCount]);
  // Liking a photo changes only the Favorites view; every other view keeps its place.
  const favoritesFor = active === 'favorites' ? favorites : null;

  // A new hand of Surprise Me each time it's pressed.
  const surprise = useMemo(() => deal(all.filter((p) => !p.kind.frame), SURPRISE), [all, hand]); // eslint-disable-line react-hooks/exhaustive-deps

  // What the view holds before search and chips, then after.
  const base = useMemo(() => {
    if (folder) return all.filter((p) => inFolder(p, folder));
    if (active === 'surprise') return surprise;
    if (active === 'all' && settings.framesInAll) return all;
    return all.filter((p) => category.test(p, favoritesFor ?? new Set()));
  }, [all, folder, active, surprise, category, favoritesFor, settings.framesInAll]);
  const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const searched = useMemo(() => base.filter((p) => matches(p, words)), [base, words]);
  const subfolders = useMemo(() => (folder ? (folders.find((f) => f.path === folder)?.children ?? []) : []), [folder, folders]);

  // The Filter menu: inside a folder, the folders in it first; then shape, kind and format. Any one
  // ticked in a group will do; every group with one ticked must match.
  const facets = useMemo(() => {
    type Option = { value: string; label: string; icon: ReactNode; test: (p: Indexed) => boolean };
    const out: { id: string; label: string; options: Option[] }[] = [];
    if (subfolders.length) {
      out.push({
        id: 'folders',
        label: 'Folders',
        options: subfolders.map((f) => ({ value: `in:${f.path}`, label: f.label, icon: <FolderSimpleIcon weight="fill" />, test: (p: Indexed) => inFolder(p, f.path) })),
      });
    }
    for (const g of FILTER_GROUPS) {
      out.push({ id: g.id, label: g.label, options: FILTERS.filter((f) => f.group === g.id).map((f) => ({ value: f.value, label: f.label, icon: FILTER_ICONS[f.value], test: f.test })) });
    }
    return out;
  }, [subfolders]);
  const { shown, filterGroups } = useMemo(() => {
    const ticked = facets.map((f) => f.options.filter((o) => filters.includes(o.value)));
    const passes = (p: Indexed, skip: number) => ticked.every((on, k) => k === skip || !on.length || on.some((o) => o.test(p)));
    const shown = filters.length ? searched.filter((p) => passes(p, -1)) : searched;
    // Each option counts what you'd see with it ticked, given what's ticked in the other groups.
    const filterGroups: FilterGroup[] = facets.map((f, k) => {
      const rest = ticked.some((on, j) => j !== k && on.length) ? searched.filter((p) => passes(p, k)) : searched;
      return {
        label: f.label,
        options: f.options
          .map((o) => ({ value: o.value, label: o.label, icon: o.icon, count: rest.filter(o.test).length }))
          .filter((o) => o.count > 0 || filters.includes(o.value)),
      };
    });
    return { shown, filterGroups };
  }, [facets, searched, filters]);

  const goRef = useRef<(id: string) => void>(() => {});
  const go = useCallback((id: string) => {
    setViewer(null);
    setFinder(null);
    setPointAt(null);
    setActive(id);
    setFilters([]);
    setQuery('');
    if (id === 'surprise') setHand((n) => n + 1);
    scroller.current?.scrollTo({ top: 0 });
  }, []);
  goRef.current = go;

  useEffect(() => scroller.current?.scrollTo({ top: 0 }), [query, filters]);

  // Pictures opened from Finder (a double-click, Open With) open on their own: the viewer fills the
  // window, with no sidebar. One picture comes with the others in its folder; several, just those.
  // "See folder in Pinboard" goes on into the whole app. They can arrive before the library has
  // loaded, so they wait for it (the sidebar goes at once, so it doesn't flash).
  const [opened, setOpened] = useState<{ ids: string[]; extra: Photo[] } | null>(null);
  const finderRef = useRef(finder);
  finderRef.current = finder;
  /** The window was put away by closing a picture from Finder: the next one is on its own again. */
  const putAway = useRef(false);
  /** The picture on screen in the viewer, for "See folder in Pinboard". */
  const onScreen = useRef<Indexed | null>(null);
  useEffect(() => {
    const take = () =>
      void takeOpened()
        .then((got) => {
          if (!got.ids.length) return;
          const back = got.cold || putAway.current ? 'hide' : (finderRef.current?.back ?? 'pinboard');
          putAway.current = false;
          setFinder({ back });
          setOpened((now) => (now ? { ids: [...now.ids, ...got.ids], extra: [...now.extra, ...got.extra] } : got));
        })
        .catch(() => {});
    take();
    const offs: Array<() => void> = [];
    void listen('opened', take)
      .then((un) => offs.push(un))
      .catch(() => {});
    // The Dock icon brought the window back: it shows Pinboard itself.
    void listen('reopened', () => (putAway.current = false))
      .then((un) => offs.push(un))
      .catch(() => {});
    return () => offs.forEach((off) => off());
  }, []);
  useEffect(() => {
    if (!opened || !photos) return;
    setOpened(null);
    const byId = new Map(photos.map((p) => [p.id, p]));
    const extra = classify(opened.extra.filter((p) => !byId.has(p.id)));
    for (const p of extra) byId.set(p.id, p);
    const picked = [...new Set(opened.ids)].map((id) => byId.get(id)).filter((p): p is Indexed => !!p);
    if (!picked.length) return setFinder(null);
    const one = picked.length === 1 ? picked[0] : null;
    const list = one && !extra.includes(one) ? photos.filter((p) => p.folder === one.folder) : picked;
    const start = one ? Math.max(0, list.indexOf(one)) : 0;
    onScreen.current = list[start] ?? null;
    setViewer({ list, start, key: Date.now() });
  }, [opened, photos]);

  /** Closing a picture opened from Finder: back to Pinboard as it was, or put the window away. */
  const closeFinder = useCallback(() => {
    const back = finderRef.current?.back;
    setFinder(null);
    setViewer(null);
    if (back === 'hide') {
      putAway.current = true;
      void hideWindow().catch(() => {});
    }
  }, []);
  /** "See folder in Pinboard": the whole app, at the picture's folder, with the picture pointed out. */
  const libraryIds = useMemo(() => new Set((photos ?? []).map((p) => p.id)), [photos]);
  const seeFolder = useCallback(() => {
    const p = onScreen.current;
    const known = !!p && libraryIds.has(p.id);
    go(known && p.folder ? `folder:${p.folder}` : 'all');
    setPointAt(known ? { id: p.id, tick: Date.now() } : null);
  }, [libraryIds, go]);
  // A new view, a new search or new filters start with nothing ticked.
  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
  }, [active, query, filters]);
  /** What's ticked, in the order it's shown. */
  const picked = useMemo(() => (selected.size ? shown.filter((p) => selected.has(p.id)) : []), [shown, selected]);

  // Moving to the Trash, and Undo from the toast puts them back.
  const trash = useCallback(async (list: Indexed[]) => {
    const { trashed, failed } = await trashPhotos(list.map((p) => p.id));
    const gone = new Set(trashed);
    const records = list.filter((p) => gone.has(p.id));
    setPhotos((now) => now && now.filter((p) => !gone.has(p.id)));
    setSelected(new Set());
    if (trashed.length) {
      toast(`Moved ${pictures(trashed.length)} to the Trash`, {
        description: 'Put them back from the Trash in Finder any time.',
        duration: 9000,
        action: {
          label: 'Undo',
          onClick: () =>
            void putBack(trashed)
              .then((back) => {
                const again = new Set(back);
                setPhotos((now) => now && [...now, ...records.filter((p) => again.has(p.id))].sort((a, b) => b.taken - a.taken));
                if (back.length < trashed.length) toast(`Put back ${back.length} of ${trashed.length}`, { description: 'The rest are still in the Trash.', tone: 'stop' });
              })
              .catch((e) => toast("Couldn't put them back", { description: String(e), tone: 'stop' })),
        },
      });
    }
    if (failed.length) toast(`Couldn't move ${pictures(failed.length)}`, { description: "They may be locked, or already gone.", tone: 'stop' });
  }, []);

  const actions: CardActions = useMemo(
    () => ({
      open: (p) => setViewer({ list: shown, start: Math.max(0, shown.findIndex((x) => x.id === p.id)) }),
      favorite: (p) => {
        const on = !favorites.has(p.id);
        toggleFavorite(p.id);
        toast(on ? 'Added to Favorites' : 'Removed from Favorites', { description: p.name, duration: 2200 });
      },
      reveal: (p) => void reveal(p.id).catch((e) => toast("Couldn't show it in Finder", { description: String(e), tone: 'stop' })),
      openWith: (p) => void openPhoto(p.id).catch((e) => toast("Couldn't open it", { description: String(e), tone: 'stop' })),
      copy: (p) =>
        void copyPhoto(p.id)
          .then(() => toast('Copied', { description: `${p.name}: paste it into Messages, Mail or Finder.`, tone: 'ok', duration: 2400 }))
          .catch((e) => toast("Couldn't copy it", { description: String(e), tone: 'stop' })),
      openFolder: (f) => go(`folder:${f}`),
      select: (p, how) => {
        // Read where the run starts now: the updater below runs later, after the anchor has moved.
        const from = how === 'range' && anchor.current ? shown.findIndex((x) => x.id === anchor.current) : -1;
        const to = shown.findIndex((x) => x.id === p.id);
        setSelected((now) => {
          const next = new Set(now);
          if (from >= 0 && to >= 0) {
            for (let k = Math.min(from, to); k <= Math.max(from, to); k++) next.add(shown[k].id);
          } else if (!next.delete(p.id)) next.add(p.id);
          return next;
        });
        anchor.current = p.id;
      },
      trash: (list) => setToTrash(list),
    }),
    [shown, favorites, toggleFavorite, go],
  );

  const nav: NavItem[] = useMemo(() => [
    { id: 'all', label: 'All Photos', icon: HouseSimpleIcon },
    { id: 'recent', label: 'Recent', icon: ClockIcon },
    { id: 'favorites', label: 'Favorites', icon: HeartIcon },
    { id: 'screenshots', label: 'Screenshots', icon: MonitorIcon, hidden: !counts.screenshots },
    { id: 'camera', label: 'Camera', icon: CameraIcon, hidden: !counts.camera },
    { id: 'frames', label: 'Video Frames', icon: FilmStripIcon, hidden: !counts.frames },
    { id: 'surprise', label: 'Surprise Me', icon: SparkleIcon, badge: 'New' },
  ], [counts]);
  const openSearch = useCallback(() => setPalette(true), []);
  const refresh = useCallback(() => void scan(), [scan]);
  const hideFolder = useCallback(
    (path: string) => {
      update((now) => ({ hidden: [...now.hidden.filter((h) => !h.startsWith(`${path}/`) && h !== path), path] }));
      setActive((a) => (a === `folder:${path}` || a.startsWith(`folder:${path}/`) ? 'all' : a));
      toast('Hidden from Pinboard', { description: `${path.split('/').pop()}: bring it back in Settings.`, duration: 2800 });
    },
    [update],
  );

  /** A new view: what you're looking at and how it's narrowed. Search narrows in place. */
  const viewKey = `${active}|${filters.join(',')}|${active === 'surprise' ? hand : ''}`;

  selectionKeys.current = (e) => {
    const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, [contenteditable="true"], [role="menu"], [role="dialog"]');
    if (typing || viewer || palette || toTrash || active === 'settings') return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && shown.length) {
      e.preventDefault();
      setSelected(new Set(shown.map((p) => p.id)));
    } else if (e.key === 'Escape' && selected.size) {
      setSelected(new Set());
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace' && picked.length) {
      e.preventDefault();
      setToTrash(picked);
    }
  };

  const allFavorite = picked.length > 0 && picked.every((p) => favorites.has(p.id));
  const ids = () => picked.map((p) => p.id);
  const many = (n: number) => (n === 1 ? 'it' : 'them');

  /* ---------- the header ---------- */

  const onSettings = active === 'settings';
  const title = onSettings ? 'Settings' : folder ? (folder.split('/').pop() ?? folder) : (nav.find((n) => n.id === active)?.label ?? category.label);
  const parent = folder?.includes('/') ? folder.slice(0, folder.lastIndexOf('/')).replaceAll('/', ' / ') : null;

  /* ---------- the viewer ---------- */

  const viewerPhotos: ViewerPhoto[] = useMemo(
    () =>
      (viewer?.list ?? []).map((p) => ({
        id: p.id,
        src: thumbUrl(p.id, settings.quality === 'sharp' ? 2048 : 1024),
        preview: thumbUrl(p.id, 512),
        thumb: thumbUrl(p.id, 256),
        alt: p.name,
        width: p.width,
        height: p.height,
        caption: (
          <span title={p.path} className="flex min-w-0 max-w-full items-center justify-center gap-2.5 whitespace-nowrap">
            <span className="min-w-0 truncate font-medium text-white">{p.name}</span>
            {[p.folder.split('/').pop() || 'Home', dateOf(p.taken), p.width && p.height && !p.approx ? `${p.width} × ${p.height}` : null, sizeOf(p.bytes), p.camera]
              .filter(Boolean)
              .map((bit, i) => (
                <span key={i} className="flex shrink-0 items-center gap-2.5 text-white/50">
                  <span aria-hidden className="size-[3px] rounded-full bg-white/30" />
                  {bit}
                </span>
              ))}
          </span>
        ),
      })),
    [viewer, settings.quality],
  );

  const viewerActions = (i: number) => {
    const p = viewer?.list[i];
    if (!p) return null;
    const fav = favorites.has(p.id);
    return (
      <>
        <GlassButton label={fav ? 'Remove from Favorites' : 'Add to Favorites'} onClick={() => actions.favorite(p)} active={fav}>
          <HeartIcon weight={fav ? 'fill' : 'regular'} className="size-4" />
        </GlassButton>
        <GlassButton label="Show in Finder" onClick={() => actions.reveal(p)}>
          <FolderOpenIcon weight="regular" className="size-4" />
        </GlassButton>
      </>
    );
  };

  /** The sidebar is away when you fold it, and while a picture from Finder is shown on its own. */
  const folded = collapsed || !!finder;

  /* ---------- the page ---------- */

  let body: ReactNode;
  if (error) {
    body = <EmptyState className="mx-auto my-24 max-w-[480px]" icon={<ImagesSquareIcon weight="duotone" />} title="Couldn't read your pictures" description={error} action={<Button onClick={() => void scan()}>Try Again</Button>} />;
  } else if (!photos) {
    body = <MasonrySkeleton />;
  } else if (!shown.length) {
    const searching = words.length > 0 || filters.length > 0;
    body = (
      <EmptyState
        className="mx-auto my-24 max-w-[480px]"
        icon={active === 'favorites' ? <HeartIcon weight="duotone" /> : <MagnifyingGlassIcon weight="duotone" />}
        title={searching ? 'Nothing matches' : active === 'favorites' ? 'No favorites yet' : 'No pictures here'}
        description={
          searching
            ? 'Try another word: a file name, a folder, a camera, or a month like “october”.'
            : active === 'favorites'
              ? 'Point at a picture and press Like to keep it here.'
              : 'Pictures you save on this Mac show up here on their own.'
        }
        action={
          searching ? (
            <Button variant="outline" onClick={() => (setQuery(''), setFilters([]))}>
              Clear Search
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = <Masonry key={viewKey} photos={shown} favorites={favorites} selected={selected} actions={actions} column={COLUMN_WIDTH[settings.cardSize]} hoverActions={settings.hoverActions} focus={pointAt} />;
  }

  return (
    <div data-tauri-drag-region className="flex h-full">
      {/* The sidebar stays on the page and only slides to nothing, so bringing it back costs no rebuild. */}
      <motion.div
        initial={false}
        animate={{ width: folded ? 0 : 272, opacity: folded ? 0 : 1 }}
        transition={finder ? { duration: 0 } : { width: FOLD, opacity: { duration: 0.18 } }}
        className="h-full shrink-0 overflow-hidden"
        inert={folded}
        aria-hidden={folded || undefined}
      >
        <Sidebar
          appName={APP_NAME}
          appIcon={fullscreen ? appIcon : undefined}
          nav={nav}
          folders={tree}
          active={active}
          onSelect={go}
          onSearch={openSearch}
          onRefresh={refresh}
          onHide={hideFolder}
          refreshing={scanning}
          status={photos ? `${pictures(photos.length)} · ${scanning ? 'updating…' : `updated ${ago(scannedAt)}`}` : 'Finding your pictures…'}
        />
      </motion.div>

      {/* The photos sit on a raised panel, inset from the window's edges, the sidebar on the window itself. */}
      <motion.main
        ref={panel}
        initial={false}
        animate={{ marginLeft: folded ? 5 : 0 }}
        transition={finder ? { duration: 0 } : FOLD}
        className="relative my-[5px] mr-[5px] flex min-w-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-ink/[0.08] bg-panel shadow-[var(--pb-panel-shadow)]"
      >
        <motion.header data-tauri-drag-region initial={false} animate={{ paddingLeft: folded && !fullscreen ? 86 : 22 }} transition={finder ? { duration: 0 } : FOLD} className="flex h-[54px] shrink-0 items-center gap-3 border-b border-ink/[0.07] pr-6">
          {/* The sidebar's one switch, always here in the body, just left of the title. */}
          <Tip content={collapsed ? 'Show sidebar' : 'Hide sidebar'} keys={['⌘', '\\']}>
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
              aria-pressed={!collapsed}
              className="-ml-1.5 grid size-8 shrink-0 place-items-center rounded-lg text-ink/50 transition-colors hover:bg-ink/[0.06] hover:text-ink"
            >
              <SidebarSimpleIcon className="size-[19px]" />
            </button>
          </Tip>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.h1 key={title} data-tauri-drag-region initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }} className="font-display truncate text-[21px] text-ink">
              {title}
            </motion.h1>
          </AnimatePresence>
          <span data-tauri-drag-region data-count className="min-w-0 truncate text-[13px] tabular-nums text-ink/45">
            {onSettings ? null : [parent, photos ? pictures(shown.length) : null].filter(Boolean).join('  ·  ')}
          </span>
        </motion.header>

        <div ref={scroller} data-scroller className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 pt-6">
          {blocked.length > 0 && !blockedNoted && (
            <Alert
              tone="warn"
              title={`Pinboard can't see your ${blocked.join(' and ').replace(/ and (?=[^ ]+ and )/g, ', ')} ${blocked.length === 1 ? 'folder' : 'folders'}`}
              onDismiss={() => setBlockedNoted(true)}
              className="mb-5"
              actions={
                <>
                  <Button size="sm" onClick={() => void openPrivacySettings()}>
                    Open System Settings
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void scan()}>
                    Look Again
                  </Button>
                </>
              }
            >
              Allow Pinboard in Privacy &amp; Security › Files and Folders, then look again. Pictures stay on your Mac.
            </Alert>
          )}
          {onSettings ? (
            <SettingsPage
              settings={settings}
              update={update}
              reset={reset}
              pictures={all.length}
              folders={folders.length}
              blocked={blocked}
              scannedAt={scannedAt}
              appName={APP_NAME}
              onRescan={refresh}
            />
          ) : (
            <>
          {/* A quiet field, like the reference's "Type a mood…" (⌘F finds it), and the Filter menu beside it. */}
          <div className="flex items-center gap-2">
          <label className="flex h-[44px] min-w-0 flex-1 items-center gap-3 rounded-[12px] border border-ink/[0.08] bg-ink/[0.025] px-4 transition-colors focus-within:border-ink/[0.16] focus-within:bg-ink/[0.04]">
            <MagnifyingGlassIcon className="size-[17px] shrink-0 text-ink/40" />
            <input
              ref={search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('');
              }}
              placeholder={folder ? `Search ${title}` : 'Search by name, folder or month'}
              aria-label="Search pictures"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[14.5px] text-ink outline-none placeholder:text-ink/35"
            />
            <AnimatePresence initial={false}>
              {query && (
                <motion.button
                  key="clear"
                  type="button"
                  aria-label="Clear search"
                  onClick={() => (setQuery(''), search.current?.focus())}
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={{ duration: 0.15 }}
                  className="grid size-5 place-items-center rounded-full bg-ink/15 text-ink/80 hover:bg-ink/25"
                >
                  <XIcon weight="bold" className="size-2.5" />
                </motion.button>
              )}
            </AnimatePresence>
          </label>
          <FilterMenu groups={photos ? filterGroups : []} value={filters} onValueChange={setFilters} />
          </div>

          <div className="mt-5 min-h-[calc(100%-70px)] rounded-t-[22px] bg-well p-3.5 pb-16">{body}</div>
            </>
          )}
        </div>
        {/* A picture from Finder on its way (the library still loading): dark, like the viewer. */}
        {finder && !viewer && <div aria-hidden className="absolute inset-0 z-20 bg-[rgb(6_6_7)]" />}

        {/* What's ticked, and what to do with it, floating at the foot of the panel. */}
        <ActionBar count={onSettings ? 0 : picked.length} onClear={() => setSelected(new Set())} label="Ticked photos" position="absolute" className="bottom-5">
          <ActionBarButton
            icon={<HeartIcon weight={allFavorite ? 'fill' : 'regular'} />}
            onClick={() => {
              setFavorites(ids(), !allFavorite);
              toast(allFavorite ? `Removed ${pictures(picked.length)} from Favorites` : `Added ${pictures(picked.length)} to Favorites`, { duration: 2200 });
            }}
          >
            {allFavorite ? 'Unfavorite' : 'Favorite'}
          </ActionBarButton>
          <ActionBarButton
            icon={<CopyIcon />}
            onClick={() =>
              void copyPhotos(ids())
                .then(() => toast(`Copied ${pictures(picked.length)}`, { description: `Paste ${many(picked.length)} into Messages, Mail or Finder.`, tone: 'ok', duration: 2400 }))
                .catch((e) => toast("Couldn't copy them", { description: String(e), tone: 'stop' }))
            }
          >
            Copy
          </ActionBarButton>
          <ActionBarButton icon={<FolderOpenIcon />} onClick={() => void revealPhotos(ids()).catch((e) => toast("Couldn't show them in Finder", { description: String(e), tone: 'stop' }))}>
            Show in Finder
          </ActionBarButton>
          <ActionBarButton icon={<ArrowSquareOutIcon />} disabled={picked.length > OPEN_AT_MOST} onClick={() => void openPhotos(ids()).catch((e) => toast("Couldn't open them", { description: String(e), tone: 'stop' }))}>
            Open
          </ActionBarButton>
          {picked.length < shown.length && (
            <ActionBarButton icon={<ChecksIcon />} onClick={() => setSelected(new Set(shown.map((p) => p.id)))}>
              Select All
            </ActionBarButton>
          )}
          <ActionBarButton icon={<TrashIcon />} tone="stop" onClick={() => setToTrash(picked)}>
            Move to Trash
          </ActionBarButton>
        </ActionBar>
      </motion.main>

      {/* Moving to the Trash asks first, and says how to undo it. */}
      <Dialog open={!!toTrash} onOpenChange={(o) => !o && setToTrash(null)}>
        <DialogContent size="sm">
          <DialogIcon>
            <TrashIcon weight="duotone" />
          </DialogIcon>
          <DialogTitle>{toTrash?.length === 1 ? `Move “${toTrash[0].name}” to the Trash?` : `Move ${pictures(toTrash?.length ?? 0)} to the Trash?`}</DialogTitle>
          <DialogDescription>Nothing is deleted yet: Undo brings {many(toTrash?.length ?? 0)} back, and so does Put Back in the Trash, until you empty it.</DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              data-confirm-trash
              className="![background:#e5484d] !text-white"
              onClick={() => {
                const list = toTrash ?? [];
                setToTrash(null);
                void trash(list).catch((e) => toast("Couldn't move them to the Trash", { description: String(e), tone: 'stop' }));
              }}
            >
              Move to Trash
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {viewer && (
        <PhotoViewer
          key={viewer.key}
          photos={viewerPhotos}
          start={viewer.start}
          container={panel}
          filmstrip={settings.filmstrip}
          tileFor={(i) => document.querySelector<HTMLElement>(`[data-photo="${viewer.list[i]?.id}"]`)}
          onClose={finder ? closeFinder : () => setViewer(null)}
          onIndex={(i) => (onScreen.current = viewer.list[i] ?? null)}
          actions={viewerActions}
          backdropCloses={!finder}
          // On its own (from Finder), the row of buttons lines up with the traffic lights, and a way
          // into the rest of Pinboard sits beside them.
          barTop={finder && !fullscreen ? 7 : 16}
          leadInset={fullscreen ? 16 : 84}
          lead={
            finder
              ? (i) => (
                  <button
                    type="button"
                    data-see-folder
                    onClick={seeFolder}
                    className="flex h-10 items-center gap-2 rounded-full bg-white/10 pl-3.5 pr-4 text-[13.5px] font-medium text-white outline-none backdrop-blur-xl transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-white"
                  >
                    <SidebarSimpleIcon className="size-[17px]" />
                    {viewer.list[i] && libraryIds.has(viewer.list[i].id) ? 'See folder in Pinboard' : 'Open Pinboard'}
                  </button>
                )
              : undefined
          }
        />
      )}

      <Search
        open={palette}
        onClose={() => setPalette(false)}
        places={[...nav.filter((n) => !n.hidden).map((n) => ({ id: n.id, label: n.label, icon: n.icon, count: n.id in counts ? counts[n.id as CategoryId] : undefined })), { id: 'settings', label: 'Settings', icon: GearSixIcon }]}
        photos={all}
        folders={folders}
        onPlace={go}
        onFolder={(path) => go(`folder:${path}`)}
        onPhoto={(p, list) => setViewer({ list, start: Math.max(0, list.indexOf(p)) })}
      />

      <Toaster position="bottom-right" />
    </div>
  );
}

/** A round glass button in the viewer, beside Close. */
function GlassButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid size-10 place-items-center rounded-full outline-none backdrop-blur-xl transition-colors focus-visible:outline-2 focus-visible:outline-white ${active ? 'bg-[#ff5a6e]/85 text-white' : 'bg-white/10 text-white hover:bg-white/20'}`}
    >
      {children}
    </button>
  );
}
