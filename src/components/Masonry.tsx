import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger, Skeleton } from '@basedraft/ui';
import { ArrowSquareOutIcon, CheckCircleIcon, CheckIcon, CopyIcon, FolderOpenIcon, FolderSimpleIcon, HeartIcon, TrashIcon } from '@phosphor-icons/react';
import { animate } from 'motion/react';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { thumbUrl } from '../lib/api';
import type { Indexed } from '../lib/library';
import { FOLD } from '../lib/motion';
import { PlaceSquare } from './Sidebar';

/** How many cards are on the page at first, and how many more join each time you near the end. */
const PAGE = 180;
const GAP = 14;
/** How long a fold holds the grid at the width it ends at: the sidebar's spring settles in this. */
const FOLD_MS = 460;


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
  focus,
  expect,
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
  /** A photo to point out: the grid goes down to it (adding cards if it's further than the first
   * page), centers it, and rings it for a moment. A new `tick` points again. */
  focus?: { id: string; tick: number } | null;
  /** The grid is about to get wider or narrower by `by` pixels (the sidebar folding). It deals for
   * the width it will end at, right away, and every card glides straight to its new place in step
   * with the sidebar: one move each, nothing reshuffling on the way. A new `tick` for each fold. */
  expect?: { by: number; tick: number } | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(PAGE);
  const [focusing, setFocusing] = useState<string | null>(null);
  /** The box has been measured: until then there's nothing to place cards in. */
  const [measured, setMeasured] = useState(false);
  /** Columns wide enough for the bigger thumbnails. */
  const [wide, setWide] = useState(false);
  /** What a deal needs, current even inside the resize observer (which runs outside React). */
  const input = useRef({ photos, shown, column });
  input.current = { photos, shown, column };
  /** Where each card goes, as last dealt, and how many columns that was. */
  const placesRef = useRef<Place[]>([]);
  const colsRef = useRef(0);
  const columnRef = useRef(column);
  const wideTimer = useRef(0);
  /** The cards gliding now, to stop if they're sent somewhere else on the way. */
  const gliding = useRef(new WeakMap<HTMLElement, { stop: () => void }>()).current;
  /** A fold the cards are following: the grid's width at its start and end, and each card's way. */
  const following = useRef<{ from: number; to: number; cards: Array<{ el: HTMLElement; dx: number; dy: number; s: number }> } | null>(null);
  /** Puts each card of a fold as far along its way as the grid's width is along the fold. */
  const follow = useCallback((width: number) => {
    const f = following.current;
    if (!f) return;
    const along = f.to === f.from ? 1 : Math.min(1, Math.max(0, (width - f.from) / (f.to - f.from)));
    const left = 1 - along;
    for (const c of f.cards) c.el.style.transform = left < 0.001 ? '' : `translate(${c.dx * left}px, ${c.dy * left}px) scale(${1 + (c.s - 1) * left})`;
    if (left < 0.001) following.current = null;
  }, []);
  /** While a fold plays: the width it ends at, and until when. Resizes in between don't deal. */
  const hold = useRef<{ width: number; until: number } | null>(null);
  /** A photo being pointed out stays in the middle while the grid settles (the sidebar sliding in
   * deals the columns again), until `until`. */
  const pin = useRef<{ index: number; until: number } | null>(null);
  const center = useCallback(() => {
    const el = box.current;
    const pinned = pin.current;
    if (!el || !pinned) return;
    if (performance.now() > pinned.until) return void (pin.current = null);
    const place = placesRef.current[pinned.index];
    const scroller = el.closest<HTMLElement>('[data-scroller]');
    if (!place || !scroller) return;
    // Where it ends up (not where it is mid-glide).
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = top + place.y + place.h / 2 - scroller.clientHeight / 2;
  }, []);

  /** Deals the cards into as many columns as fit the width, each under the shortest column, and
   * writes each card's place straight onto it: no React render. It runs on every frame of a resize,
   * so while the sidebar slides the columns reflow with it (not after); when the number of columns
   * changes, the cards glide to their new places. */
  const deal = useCallback(
    (width: number, glide: false | 'spring' | 'fold' = false) => {
      const el = box.current;
      if (!el || width <= 0) return;
      const { photos, shown, column } = input.current;
      const cols = Math.max(2, Math.floor((width + GAP) / (column + GAP)));
      const colW = (width - GAP * (cols - 1)) / cols;
      const tops = new Array(cols).fill(0);
      const n = Math.min(shown, photos.length);
      const places: Place[] = new Array(n);
      for (let i = 0; i < n; i++) {
        let at = 0;
        for (let c = 1; c < cols; c++) if (tops[c] < tops[at] - 0.5) at = c;
        const h = colW * ratioOf(photos[i]);
        places[i] = { x: at * (colW + GAP), y: tops[at], w: colW, h };
        tops[at] += h + GAP;
      }
      colsRef.current = cols;
      const cards = el.children;
      // Gliding: where each card on (or near) the screen is right now, mid-glide or not, so it can
      // be shown moving from there once it's been put in its new place.
      const box0 = glide ? el.getBoundingClientRect() : null;
      const view = glide ? el.closest('[data-scroller]')?.getBoundingClientRect() : null;
      const from: Array<DOMRect | null> = [];
      if (box0 && view) {
        for (let i = 0; i < n; i++) {
          const c = cards[i] as HTMLElement | undefined;
          const r = c?.style.top ? c.getBoundingClientRect() : null;
          const p = places[i];
          const near = (top: number, bottom: number) => bottom > view.top - 400 && top < view.bottom + 400;
          from[i] = r && (near(r.top, r.bottom) || near(box0.top + p.y, box0.top + p.y + p.h)) ? r : null;
          if (from[i]) gliding.get(c!)?.stop();
        }
        // A fold in flight, sent somewhere else: its cards carry on from where they are now.
        if (following.current) {
          for (const f of following.current.cards) f.el.style.transform = '';
          following.current = null;
        }
      }
      for (let i = 0; i < n; i++) {
        const c = cards[i] as HTMLElement | undefined;
        if (!c) continue;
        const p = places[i];
        c.style.left = `${p.x}px`;
        c.style.top = `${p.y}px`;
        c.style.width = `${p.w}px`;
        c.style.height = `${p.h}px`;
      }
      // …then each slides from where it was to where it now is, on a transform alone (no layout on
      // the way, so the sidebar's slide stays smooth). Same shape before and after, so the scale is
      // even. On the sidebar's own spring, from the same frame: a card's path on screen is then a
      // straight line from where it was to where it ends, with no drifting back.
      if (box0) {
        const moves: Array<{ el: HTMLElement; dx: number; dy: number; s: number }> = [];
        for (let i = 0; i < n; i++) {
          const r = from[i];
          if (!r) continue;
          const p = places[i];
          const dx = r.left - (box0.left + p.x);
          const dy = r.top - (box0.top + p.y);
          const s = r.width / p.w;
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(s - 1) < 0.002) continue;
          moves.push({ el: cards[i] as HTMLElement, dx, dy, s });
        }
        if (glide === 'fold') {
          // Each card follows the fold itself: however far the grid's width has got from where it
          // was to where it's going, each card has got that far along its way. Its path on screen
          // is a straight line, in step with the sidebar to the frame.
          following.current = { from: el.clientWidth, to: width, cards: moves };
          follow(el.clientWidth);
        } else {
          for (const m of moves) gliding.set(m.el, animate(m.el, { x: [m.dx, 0], y: [m.dy, 0], scale: [m.s, 1] }, FOLD));
        }
      }
      el.style.height = `${n ? Math.max(0, Math.max(...tops) - GAP) : 0}px`;
      placesRef.current = places;
      // Bigger thumbnails for wide columns, but only once a resize has settled: swapping every
      // card's picture mid-slide would make the slide stutter.
      const big = colW * 2 > 560;
      clearTimeout(wideTimer.current);
      wideTimer.current = window.setTimeout(() => setWide((now) => (now === big ? now : big)), 300);
      center();
    },
    [center, follow, gliding],
  );

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setMeasured(true);
    // A window being resized deals on every frame, so the columns follow the edge. During a fold
    // the cards are already gliding to where the fold ends, so it waits.
    const ro = new ResizeObserver(([e]) => {
      if (hold.current && performance.now() < hold.current.until) {
        follow(e.contentRect.width);
        return center();
      }
      deal(e.contentRect.width);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(wideTimer.current);
    };
  }, [deal]);

  // After every render (new photos, more of them, another card size): deal again, before the frame
  // is painted. A new card size glides the cards to their places.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !measured) return;
    const resized = columnRef.current !== column;
    columnRef.current = column;
    const folding = hold.current && performance.now() < hold.current.until ? hold.current.width : 0;
    deal(folding || el.clientWidth, resized && 'spring');
  });

  // A fold: deal once for the width it ends at, glide there, then check against the real width.
  // Before paint, in the same frame the sidebar starts to move.
  useLayoutEffect(() => {
    const el = box.current;
    if (!expect || !el) return;
    const width = el.clientWidth + expect.by;
    hold.current = { width, until: performance.now() + FOLD_MS };
    deal(width, 'fold');
    const done = window.setTimeout(() => {
      hold.current = null;
      follow(width);
      if (following.current) {
        for (const f of following.current.cards) f.el.style.transform = '';
        following.current = null;
      }
      if (Math.abs(el.clientWidth - width) > 0.5) deal(el.clientWidth, 'spring');
    }, FOLD_MS + 60);
    return () => clearTimeout(done);
  }, [expect?.tick]); // eslint-disable-line react-hooks/exhaustive-deps


  useEffect(() => {
    if (!focus) return;
    const at = photos.findIndex((p) => p.id === focus.id);
    if (at < 0) return;
    setShown((n) => Math.max(n, at + 40));
    setFocusing(focus.id);
  }, [focus?.tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Once its card is placed: straight to it (and kept there while the grid settles), then a ring
  // that fades.
  useEffect(() => {
    if (!focusing) return;
    const index = photos.findIndex((p) => p.id === focusing);
    const card = box.current?.children[index] as HTMLElement | undefined;
    if (!card?.style.top) return;
    setFocusing(null);
    pin.current = { index, until: performance.now() + 1800 };
    center();
    card.animate([{ boxShadow: '0 0 0 3px #4f8df7' }, { boxShadow: '0 0 0 3px #4f8df7', offset: 0.65 }, { boxShadow: '0 0 0 3px rgb(79 141 247 / 0)' }], { duration: 1900, easing: 'ease-out' });
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

  return (
    <div>
      <div ref={box} className="relative">
        {(measured ? photos.slice(0, shown) : []).map((p, i) => {
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
        className="card-in group/card absolute overflow-hidden rounded-[12px] bg-tile"
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
            <span className="grid size-full place-items-center px-3 text-center text-xs text-ink/45">{photo.name}</span>
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
