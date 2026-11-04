import { FolderSimpleIcon, MagnifyingGlassIcon, type Icon } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { thumbUrl } from '../lib/api';
import { count, matches, type FolderNode, type Indexed } from '../lib/library';

export type SearchPlace = { id: string; label: string; icon: Icon; count?: number };

type Item =
  | { kind: 'place'; key: string; place: SearchPlace }
  | { kind: 'photo'; key: string; photo: Indexed; list: Indexed[]; index: number }
  | { kind: 'folder'; key: string; folder: FolderNode };

const POP = { type: 'spring', stiffness: 520, damping: 38 } as const;

/**
 * Pinboard's own search, over everything: the library's views, your folders (with a cover photo
 * each) and the photos themselves (as thumbnails). Before you type it offers your views, your
 * latest photos and your biggest folders. Arrows move, Enter opens, Escape closes.
 */
export function Search({
  open,
  onClose,
  places,
  photos,
  folders,
  onPlace,
  onFolder,
  onPhoto,
}: {
  open: boolean;
  onClose: () => void;
  places: SearchPlace[];
  photos: Indexed[];
  folders: FolderNode[];
  onPlace: (id: string) => void;
  onFolder: (path: string) => void;
  onPhoto: (photo: Indexed, list: Indexed[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // Fresh each time it opens.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setAt(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  // A cover for each folder: its newest picture (the library is newest first).
  const covers = useMemo(() => {
    const out = new Map<string, string>();
    for (const p of photos) {
      let f = p.folder;
      while (f) {
        if (!out.has(f)) out.set(f, p.id);
        const cut = f.lastIndexOf('/');
        f = cut < 0 ? '' : f.slice(0, cut);
      }
    }
    return out;
  }, [photos]);

  const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const found = useMemo(() => {
    const has = (text: string) => words.every((w) => text.toLowerCase().includes(w));
    if (!words.length) {
      const latest = photos.filter((p) => !p.kind.frame).slice(0, 12);
      return { places, folders: [...folders].sort((a, b) => b.count - a.count).slice(0, 5), photos: latest };
    }
    const matched: Indexed[] = [];
    for (const p of photos) {
      if (matches(p, words)) matched.push(p);
      if (matched.length >= 60) break;
    }
    // Folders whose own name matches come first, then the shallower, then the bigger.
    const q = words.join(' ');
    const rank = (f: FolderNode) => {
      const name = f.label.toLowerCase();
      return [name.startsWith(q) ? 0 : has(f.label) ? 1 : 2, f.path.split('/').length, -f.count];
    };
    const byRank = (a: FolderNode, b: FolderNode) => {
      const [x, y] = [rank(a), rank(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    };
    return { places: places.filter((p) => has(p.label)), folders: folders.filter((f) => has(f.path)).sort(byRank).slice(0, 6), photos: matched };
  }, [words, photos, folders, places]);

  // One order for the keys: before you type, views, then photos, then folders; while typing, folders first.
  const items: Item[] = useMemo(() => {
    const placeItems: Item[] = found.places.map((p) => ({ kind: 'place', key: `p:${p.id}`, place: p }));
    const photoItems: Item[] = found.photos.slice(0, 12).map((p, index) => ({ kind: 'photo', key: `i:${p.id}`, photo: p, list: found.photos, index }));
    const folderItems: Item[] = found.folders.map((f) => ({ kind: 'folder', key: `f:${f.path}`, folder: f }));
    return words.length ? [...folderItems, ...photoItems, ...placeItems] : [...placeItems, ...photoItems, ...folderItems];
  }, [found, words.length]);

  useEffect(() => setAt(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-at="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const run = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    if (item.kind === 'place') onPlace(item.place.id);
    else if (item.kind === 'folder') onFolder(item.folder.path);
    else onPhoto(item.photo, item.list);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const move = (d: number) => setAt((n) => (items.length ? (n + d + items.length) % items.length : 0));
    if (e.key === 'ArrowDown' || (e.key === 'ArrowRight' && (e.target as HTMLInputElement).selectionStart === query.length)) move(1);
    else if (e.key === 'ArrowUp' || (e.key === 'ArrowLeft' && !query)) move(-1);
    else if (e.key === 'Enter') run(items[at]);
    else if (e.key === 'Escape') onClose();
    else return;
    e.preventDefault();
  };

  const selected = items[at]?.key;
  const row = (item: Item, children: ReactNode, className: string) => (
    <button
      key={item.key}
      type="button"
      data-at={item.key === selected}
      onMouseMove={() => setAt(items.indexOf(item))}
      onClick={() => run(item)}
      className={`${className} outline-none transition-colors duration-100 ${item.key === selected ? 'bg-ink/[0.09]' : ''}`}
    >
      {children}
    </button>
  );
  const byKey = new Map(items.map((i) => [i.key, i]));
  const placeRows = found.places.map((p) => byKey.get(`p:${p.id}`)!);
  const photoRows = found.photos.slice(0, 12).map((p) => byKey.get(`i:${p.id}`)!);
  const folderRows = found.folders.map((f) => byKey.get(`f:${f.path}`)!);

  const sections: ReactNode[] = [];
  const placesSection = placeRows.length > 0 && (
    <Section key="places" title={words.length ? 'Library' : 'Go to'}>
      <div className="flex flex-wrap gap-1.5 px-3">
        {placeRows.map((item) => {
          if (item.kind !== 'place') return null;
          const I = item.place.icon;
          return row(
            item,
            <>
              <I className="size-[15px] text-ink/60" />
              {item.place.label}
            </>,
            'flex h-[32px] items-center gap-2 rounded-full border border-ink/[0.08] px-3 text-[13.5px] text-ink/85 hover:text-ink',
          );
        })}
      </div>
    </Section>
  );
  const photosSection = photoRows.length > 0 && (
    <Section key="photos" title={words.length ? 'Photos' : 'Latest'} aside={words.length && found.photos.length > 12 ? `${count(found.photos.length)}${found.photos.length >= 60 ? '+' : ''} found` : undefined}>
      <div className="grid grid-cols-6 gap-2 px-3">
        {photoRows.map((item) => {
          if (item.kind !== 'photo') return null;
          return row(
            item,
            <img src={thumbUrl(item.photo.id, 256)} alt="" loading="lazy" draggable={false} className="size-full rounded-[9px] object-cover" />,
            `aspect-square overflow-hidden rounded-[11px] p-[3px] ${item.key === selected ? 'ring-2 ring-ink/90' : ''}`,
          );
        })}
      </div>
    </Section>
  );
  const foldersSection = folderRows.length > 0 && (
    <Section key="folders" title={words.length ? 'Folders' : 'Biggest folders'}>
      <div className="flex flex-col px-2">
        {folderRows.map((item) => {
          if (item.kind !== 'folder') return null;
          const f = item.folder;
          const cover = covers.get(f.path);
          const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')).replaceAll('/', ' / ') : 'Home';
          return row(
            item,
            <>
              <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-[9px] bg-ink/[0.06]">
                {cover ? <img src={thumbUrl(cover, 256)} alt="" loading="lazy" draggable={false} className="size-full object-cover" /> : <FolderSimpleIcon className="size-4 text-ink/50" />}
              </span>
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[14px] text-ink/90">{f.label}</span>
                <span className="block truncate text-[12px] text-ink/40">{parent}</span>
              </span>
              <span className="shrink-0 text-[12.5px] tabular-nums text-ink/40">{count(f.count)}</span>
            </>,
            'flex h-[52px] w-full items-center gap-3 rounded-[11px] px-2.5',
          );
        })}
      </div>
    </Section>
  );
  if (words.length) sections.push(foldersSection, photosSection, placesSection);
  else sections.push(placesSection, photosSection, foldersSection);

  return (
    <AnimatePresence>
      {open && (
        <motion.div key="search" className="fixed inset-0 z-[110] flex justify-center pt-[11vh]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
          <div className="absolute inset-0 bg-scrim" onClick={onClose} aria-hidden />
          <motion.div
            role="dialog"
            aria-label="Search"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.99, transition: { duration: 0.12 } }}
            transition={POP}
            onKeyDown={onKey}
            className="relative flex max-h-[min(560px,76vh)] w-[min(640px,calc(100vw-48px))] flex-col overflow-hidden rounded-[18px] border border-ink/[0.1] bg-float shadow-[var(--pb-float-shadow)] backdrop-blur-2xl backdrop-saturate-150"
          >
            <div className="flex h-[58px] shrink-0 items-center gap-3 border-b border-ink/[0.07] px-5">
              <MagnifyingGlassIcon className="size-[19px] shrink-0 text-ink/45" />
              <input
                ref={input}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search photos and folders"
                aria-label="Search photos and folders"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[17px] text-ink outline-none placeholder:text-ink/35"
              />
              <span className="shrink-0 rounded-md bg-ink/[0.07] px-1.5 py-0.5 text-[11.5px] text-ink/45">esc</span>
            </div>
            <div ref={list} className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-3">
              {items.length ? (
                sections
              ) : (
                <div className="px-6 py-12 text-center">
                  <p className="text-[14.5px] text-ink/80">Nothing matches “{query.trim()}”</p>
                  <p className="mt-1 text-[13px] text-ink/40">Try part of a file name, a folder, or a month like “october”.</p>
                </div>
              )}
            </div>
            <div className="flex h-[38px] shrink-0 items-center gap-4 border-t border-ink/[0.07] px-5 text-[12px] text-ink/40">
              <span>
                <Key>↑</Key>
                <Key>↓</Key> move
              </span>
              <span>
                <Key>↵</Key> open
              </span>
              <span className="ml-auto tabular-nums">{count(photos.length)} pictures</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Section({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <section className="pt-3">
      <h3 className="flex items-baseline justify-between px-5 pb-2 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink/35">
        {title}
        {aside && <span className="normal-case tracking-normal text-ink/30">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}

function Key({ children }: { children: ReactNode }) {
  return <span className="mr-1 inline-grid min-w-[18px] place-items-center rounded-[5px] bg-ink/[0.08] px-1 text-[11px] text-ink/60">{children}</span>;
}
