import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger, Skeleton } from '@basedraft/ui';
import { ArrowSquareOutIcon, CheckCircleIcon, CheckIcon, CopyIcon, FolderOpenIcon, FolderSimpleIcon, HeartIcon, TrashIcon } from '@phosphor-icons/react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { thumbUrl } from '../lib/api';
import type { Indexed } from '../lib/library';
import { PlaceSquare } from './Sidebar';

/** How many cards are on the page at first, and how many more join each time you near the end. */
const PAGE = 180;
const GAP = 14;

export type CardActions = {
  open: (photo: Indexed) => void;
  favorite: (photo: Indexed) => void;
  reveal: (photo: Indexed) => void;
  openWith: (photo: Indexed) => void;
  copy: (photo: Indexed) => void;
  openFolder: (folder: string) => void;
  /** Ticks a photo on or off (toggle), or everything from the last one ticked to it (range). */
  select: (photo: Indexed, how: 'toggle' | 'range') => void;
  trash: (photos: Indexed[]) => void;
};

/** How tall a card is for its width: the picture's own shape, kept between wide and very tall. */
const ratioOf = (p: Indexed) => (p.width && p.height ? Math.min(1.9, Math.max(0.55, p.height / p.width)) : 1);

/** Where a card sits, in pixels at the width the grid was last dealt for. */
type Place = { x: number; y: number; w: number; h: number };

/**
 * Photos in columns, each card as tall as its picture, every card going under the shortest
 * column so the columns stay even. Shapes are known before anything loads, so nothing jumps.
 *
 * All cards share one parent and are placed by position, so they're never rebuilt. While the
 * panel resizes (the sidebar sliding, the window being dragged) the whole grid scales with it
 * through one CSS value, with no React work at all; once it settles, the cards are dealt again
 * for the new width and glide to their new places. Only the first cards are on the page; more
 * join as you scroll.
 */
export function Masonry({
  photos,
  favorites,
  selected,
  actions,
  column = 250,
  hoverActions = true,
}: {
  photos: Indexed[];
  favorites: Set<string>;
  /** The photos ticked for the action bar. While any are, a click ticks instead of opening. */
  selected: Set<string>;
  actions: CardActions;
  /** The width a column aims for; there are as many as fit. */
  column?: number;
  /** Like and Show on a card when you point at it. */
  hoverActions?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  /** The width the cards were last dealt for. */
  const [dealt, setDealt] = useState(0);
  const dealtRef = useRef(0);
  const [shown, setShown] = useState(PAGE);
  /** The column width last dealt for: a new card size glides the cards too. */
  const columnRef = useRef(column);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setDealt(el.clientWidth);
    let settle = 0;
    let still = 0;
    const ro = new ResizeObserver(([e]) => {
      const w = e.contentRect.width;
      if (dealtRef.current) el.style.setProperty('--s', String(w / dealtRef.current));
      clearTimeout(settle);
      settle = window.setTimeout(() => {
        if (Math.abs(w - dealtRef.current) < 1) return;
        // Cards glide to their new places only right after a deal, not while scaling.
        el.classList.add('gliding');
        setDealt(w);
        clearTimeout(still);
        still = window.setTimeout(() => el.classList.remove('gliding'), 480);
      }, 160);
    });
    ro.observe(el);
    return () => {
      clearTimeout(settle);
      clearTimeout(still);
      ro.disconnect();
    };
  }, []);

  // Each card's place is written straight onto it, before the frame is painted: a new deal moves
  // the cards without React rendering any of them again. A deal is laid out at its own width, so
  // no scaling is left over.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    dealtRef.current = dealt;
    el.style.setProperty('--s', '1');
    if (columnRef.current !== column) {
      columnRef.current = column;
      el.classList.add('gliding');
      window.setTimeout(() => el.classList.remove('gliding'), 480);
    }
    const cards = el.children;
    places.forEach((p, i) => {
      const c = cards[i] as HTMLElement | undefined;
      if (!c) return;
      c.style.left = `${(p.x / dealt) * 100}%`;
      c.style.width = `${(p.w / dealt) * 100}%`;
      c.style.top = `calc(${p.y}px * var(--s, 1))`;
      c.style.height = `calc(${p.h}px * var(--s, 1))`;
    });
  });

  useEffect(() => {
    const el = end.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setShown((n) => Math.min(photos.length, n + PAGE));
    }, { rootMargin: '1800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [photos.length, shown]);

  const { places, height, wide } = useMemo(() => {
    // Not measured yet (the first render, before layout): nothing to deal.
    if (!dealt) return { places: [] as Place[], height: 0, wide: false };
    const cols = Math.max(2, Math.floor((dealt + GAP) / (column + GAP)));
    const colW = (dealt - GAP * (cols - 1)) / cols;
    const tops = new Array(cols).fill(0);
    const places = photos.slice(0, shown).map((p): Place => {
      let at = 0;
      for (let c = 1; c < cols; c++) if (tops[c] < tops[at] - 0.5) at = c;
      const h = colW * ratioOf(p);
      const place = { x: at * (colW + GAP), y: tops[at], w: colW, h };
      tops[at] += h + GAP;
      return place;
    });
    return { places, height: Math.max(0, Math.max(...tops) - GAP), wide: colW * 2 > 560 };
  }, [photos, shown, dealt, column]);

  return (
    <div>
      <div ref={box} className="relative" style={{ height: `calc(${height}px * var(--s, 1))` }}>
        {places.map((_, i) => {
          const p = photos[i];
          return (
            <Card
              key={p.id}
              photo={p}
              favorite={favorites.has(p.id)}
              picked={selected.has(p.id)}
              selecting={selected.size > 0}
              big={wide}
              actions={actions}
              buttons={hoverActions}
              delay={i < 16 ? i * 30 : 0}
            />
          );
        })}
      </div>
      <div ref={end} aria-hidden className="h-px" />
    </div>
  );
}

const Card = memo(function Card({
  photo,
  favorite,
  picked,
  selecting,
  big,
  actions,
  buttons,
  delay,
}: {
  photo: Indexed;
  favorite: boolean;
  picked: boolean;
  selecting: boolean;
  big: boolean;
  actions: CardActions;
  buttons: boolean;
  delay: number;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const where = photo.folder.split('/').pop() || 'Home';
  // ⌘-click ticks one, Shift-click ticks a run; once any are ticked, a plain click ticks too.
  const click = (e: React.MouseEvent) => {
    if (e.shiftKey) actions.select(photo, 'range');
    else if (e.metaKey || e.ctrlKey || selecting) actions.select(photo, 'toggle');
    else actions.open(photo);
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger
        data-photo={photo.id}
        data-picked={picked || undefined}
        className="card-in group/card absolute overflow-hidden rounded-[12px] bg-[#18181b]"
        style={{ animationDelay: `${delay}ms` }}
      >
        <button
          type="button"
          onClick={click}
          aria-label={selecting ? `${picked ? 'Untick' : 'Tick'} ${photo.name}` : `Open ${photo.name}`}
          className="absolute inset-0 block size-full outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
        >
          {!failed ? (
            <img
              src={thumbUrl(photo.id, big ? 1024 : 512)}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
              className={`size-full object-cover transition-[opacity,scale,border-radius] duration-300 ease-[var(--bd-ease)] ${picked ? 'scale-[0.92] rounded-[8px]' : 'group-hover/card:scale-[1.025]'}`}
              style={{ opacity: loaded ? 1 : 0 }}
            />
          ) : (
            <span className="grid size-full place-items-center px-3 text-center text-xs text-[#71717a]">{photo.name}</span>
          )}
        </button>

        {/* Ticked: an edge in the selection blue around the photo, pressed in a little. */}
        {picked && <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[12px] bg-[#4f8df7]/10 shadow-[inset_0_0_0_3px_#4f8df7]" />}

        {/* Where it's from, at the top, like the account on a pin. Short cards leave it out. */}
        {!selecting && (
          <div className="card-where pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2.5 bg-gradient-to-b from-black/55 to-transparent p-3 pb-8 pr-12 opacity-0 transition-opacity duration-200 group-hover/card:opacity-100 group-focus-within/card:opacity-100">
            <span className="shrink-0 rounded-full ring-2 ring-black/25"><PlaceSquare name={photo.folder.split('/')[0]} size={28} round /></span>
            <span className="min-w-0 truncate text-[14.5px] font-medium text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.5)]">{where}</span>
          </div>
        )}

        {/* The tick, top right: on a card you point at, and on every card while any are ticked. */}
        <button
          type="button"
          aria-label={picked ? `Untick ${photo.name}` : `Tick ${photo.name}`}
          aria-pressed={picked}
          data-tick
          onClick={(e) => {
            e.stopPropagation();
            actions.select(photo, e.shiftKey ? 'range' : 'toggle');
          }}
          className={`absolute right-2.5 top-2.5 grid size-[26px] place-items-center rounded-full outline-none transition-[opacity,background-color,scale] duration-150 active:scale-90 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-white ${
            picked
              ? 'bg-[#4f8df7] text-white opacity-100 shadow-[0_1px_4px_rgb(0_0_0/0.35)]'
              : `bg-black/25 text-transparent shadow-[inset_0_0_0_2px_rgb(255_255_255/0.92),0_1px_4px_rgb(0_0_0/0.3)] backdrop-blur-sm hover:bg-black/40 hover:text-white/70 ${selecting ? 'opacity-100' : 'opacity-0 group-hover/card:opacity-100'}`
          }`}
        >
          <CheckIcon weight="bold" className="size-[14px]" />
        </button>

        {/* And the two things you'd do with it. Narrow cards keep just their icons. */}
        {buttons && !selecting && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-2 bg-gradient-to-t from-black/45 to-transparent p-3 pt-10 opacity-0 transition-opacity duration-200 group-hover/card:opacity-100 group-focus-within/card:opacity-100">
            <Pill onClick={() => actions.favorite(photo)} tone={favorite ? 'liked' : 'like'} label={favorite ? 'Remove from Favorites' : 'Add to Favorites'}>
              <HeartIcon weight="fill" className="size-[17px] shrink-0" />
              <span className="pill-label">{favorite ? 'Liked' : 'Like'}</span>
            </Pill>
            <Pill onClick={() => actions.reveal(photo)} tone="glass" label="Show in Finder">
              <FolderOpenIcon weight="regular" className="size-[17px] shrink-0" />
              <span className="pill-label">Show</span>
            </Pill>
          </div>
        )}

        {favorite && !selecting && <HeartIcon weight="fill" aria-label="Favorite" className="pointer-events-none absolute right-3 top-3 size-[18px] text-[#ff5a6e] drop-shadow transition-opacity group-hover/card:opacity-0" />}
      </ContextMenuTrigger>
      <ContextMenuContent label={photo.name}>
        <ContextMenuItem icon={<ArrowSquareOutIcon />} onSelect={() => actions.open(photo)}>View</ContextMenuItem>
        <ContextMenuItem icon={<ArrowSquareOutIcon />} onSelect={() => actions.openWith(photo)}>Open in Default App</ContextMenuItem>
        <ContextMenuItem icon={<FolderOpenIcon />} onSelect={() => actions.reveal(photo)}>Show in Finder</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem icon={<HeartIcon weight={favorite ? 'fill' : 'regular'} />} onSelect={() => actions.favorite(photo)}>
          {favorite ? 'Remove from Favorites' : 'Add to Favorites'}
        </ContextMenuItem>
        <ContextMenuItem icon={<CopyIcon />} onSelect={() => actions.copy(photo)}>Copy</ContextMenuItem>
        <ContextMenuItem icon={<CheckCircleIcon />} onSelect={() => actions.select(photo, 'toggle')}>{picked ? 'Untick' : 'Select'}</ContextMenuItem>
        {photo.folder && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem icon={<FolderSimpleIcon />} onSelect={() => actions.openFolder(photo.folder)}>Go to “{where}”</ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem icon={<TrashIcon />} tone="stop" onSelect={() => actions.trash([photo])}>
          Move to Trash…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

/** A glass pill on a card, like Like and Save on a pin. */
function Pill({ onClick, tone, label, children }: { onClick: () => void; tone: 'like' | 'liked' | 'glass'; label: string; children: React.ReactNode }) {
  const look = {
    like: 'bg-[rgb(255_90_110/0.28)] text-[#ff9aa6] hover:bg-[rgb(255_90_110/0.4)]',
    liked: 'bg-[#ff5a6e] text-white',
    glass: 'bg-white/20 text-white hover:bg-white/30',
  }[tone];
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`pill pointer-events-auto flex h-[38px] items-center gap-1.5 rounded-full px-4 text-[14.5px] font-medium backdrop-blur-xl transition-[background-color,scale] duration-150 active:scale-95 ${look}`}
    >
      {children}
    </button>
  );
}

/** Grey cards in columns while the library loads. */
export function MasonrySkeleton() {
  const heights = [[1.4, 0.8, 1.2], [1, 1.5, 0.7], [1.3, 0.9, 1.1], [0.8, 1.3, 1]];
  return (
    <div className="flex items-start" style={{ gap: GAP }} aria-hidden>
      {heights.map((col, c) => (
        <div key={c} className="flex flex-1 flex-col" style={{ gap: GAP }}>
          {col.map((h, i) => (
            <Skeleton key={i} className="!block !w-full !rounded-[12px]" style={{ aspectRatio: `1 / ${h}` }} />
          ))}
        </div>
      ))}
    </div>
  );
}
