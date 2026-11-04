// Adapted from the Lightbox in basedraft UI (@basedraft/ui, lightbox.tsx):
// the same dark viewer that grows a photo out of its tile and shrinks it back, with swipes, keys
// and focus kept inside. Changed for a photo library: it opens inside the app's own panel (not the
// whole window), from tiles the app lays out itself; it knows each photo's shape up front instead of
// reading it off a loaded thumbnail; it shows the small cached copy at once and sharpens to the large
// one; it carries actions (favorite, Finder) beside Close; and a filmstrip of the photos around it
// glides along at the foot, to see what's next and jump to it. Going from one photo to the next,
// each keeps a frame of its own shape and they fade into each other where they sit, so neither is
// ever cut to the other's shape or slid under an edge.
import { CaretLeftIcon, CaretRightIcon, XIcon } from "@phosphor-icons/react";
import { animate, AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

export type ViewerPhoto = {
  id: string;
  /** The large copy, loaded once it's open. */
  src: string;
  /** The small copy the tile already has: shown straight away. */
  preview: string;
  /** A tiny copy for the filmstrip. */
  thumb: string;
  alt: string;
  width: number;
  height: number;
  caption?: ReactNode;
};

type Box = { left: number; top: number; width: number; height: number };
type Area = { left: number; top: number; width: number; height: number };

/** Room kept above the photo (its buttons) and below it (caption, and the filmstrip if it's on). */
const TOP = 76;
const BOTTOM = 178;
const BOTTOM_BARE = 96;
const RADIUS = 14;

/** The largest box of the picture's shape that fits the panel between the buttons and the filmstrip, centered. In the panel's own coordinates. */
function fit(w: number, h: number, area: Area, bottom: number): Box {
  const maxW = Math.max(120, area.width - (area.width < 640 ? 24 : 152));
  const maxH = Math.max(120, area.height - TOP - bottom);
  const s = Math.min(maxW / w, maxH / h, 1.6);
  const width = Math.round(w * s);
  const height = Math.round(h * s);
  return { left: Math.round((area.width - width) / 2), top: Math.round(TOP + (maxH - height) / 2), width, height };
}

/** Where the picture starts (or ends) to sit exactly over a tile: scaled to cover it, clipped to its shape. */
function fromTile(t: DOMRect, f: Box, area: Area, radius: number) {
  const s = Math.max(t.width / f.width, t.height / f.height);
  const ix = (f.width - t.width / s) / 2;
  const iy = (f.height - t.height / s) / 2;
  return {
    x: t.left - area.left + t.width / 2 - (f.left + f.width / 2),
    y: t.top - area.top + t.height / 2 - (f.top + f.height / 2),
    scale: s,
    clipPath: `inset(${iy}px ${ix}px ${iy}px ${ix}px round ${radius / s}px)`,
  };
}
const REST = { x: 0, y: 0, scale: 1, clipPath: `inset(0px 0px 0px 0px round ${RADIUS}px)` };
const SPRING = { type: "spring", stiffness: 260, damping: 30 } as const;
const GLIDE = { type: "spring", stiffness: 300, damping: 34, mass: 0.9 } as const;
const shape = (p: ViewerPhoto) => (p.width && p.height ? { w: p.width, h: p.height } : { w: 4, h: 3 });
const areaOf = (el: HTMLElement | null): Area => {
  const r = el?.getBoundingClientRect();
  return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : { left: 0, top: 0, width: innerWidth, height: innerHeight };
};

export function PhotoViewer({
  photos,
  start,
  container,
  tileFor,
  onIndex,
  onClose,
  actions,
  filmstrip = true,
  lead,
  leadInset = 16,
  backdropCloses = true,
  barTop = 16,
}: {
  photos: ViewerPhoto[];
  start: number;
  /** The panel it opens in, and stays inside. */
  container: RefObject<HTMLElement | null>;
  /** The tile a photo sits in, to grow out of and shrink back into (null when it isn't on the page). */
  tileFor: (index: number) => HTMLElement | null;
  onIndex?: (index: number) => void;
  onClose: () => void;
  /** Buttons for the photo on screen, beside Close. */
  actions?: (index: number) => ReactNode;
  /** The strip of nearby photos at the foot. */
  filmstrip?: boolean;
  /** Something at the top left, level with the buttons (a way into the rest of the app). */
  lead?: (index: number) => ReactNode;
  /** How far in from the left it sits (past the window's traffic lights, when they're there). */
  leadInset?: number;
  /** Whether a click on the dark around the photo closes it. */
  backdropCloses?: boolean;
  /** Where the row of buttons at the top sits (to line up with the window's traffic lights). */
  barTop?: number;
}) {
  const still = useReducedMotion();
  const [i, setI] = useState(start);
  const [dir, setDir] = useState(0);
  const [closing, setClosing] = useState(false);
  const [area, setArea] = useState<Area>(() => areaOf(container.current));
  const [sharp, setSharp] = useState<Record<string, boolean>>({});
  const dialog = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const im = photos[i];
  const many = photos.length > 1;
  const bottom = filmstrip && many ? BOTTOM : BOTTOM_BARE;
  const boxOf = (p: ViewerPhoto) => fit(shape(p).w, shape(p).h, area, bottom);
  const box = boxOf(im);
  /** The layer of the photo on screen that grows out of its tile and back (the one fading out has its own). */
  const frameOf = (p: ViewerPhoto) => dialog.current?.querySelector<HTMLElement>(`[data-frame="${p.id}"]`) ?? null;

  // It follows the panel as the window or the sidebar changes.
  useEffect(() => {
    const el = container.current;
    const place = () => setArea(areaOf(el));
    const ro = el ? new ResizeObserver(place) : null;
    if (el) ro!.observe(el);
    addEventListener("resize", place);
    return () => {
      ro?.disconnect();
      removeEventListener("resize", place);
    };
  }, [container]);

  // Opening: the picture grows out of its tile.
  useLayoutEffect(() => {
    const el = frameOf(photos[start]);
    const tile = tileFor(start);
    const t = tile?.getBoundingClientRect();
    if (!el || !first.current) return;
    first.current = false;
    if (still || !t) return;
    const radius = parseFloat(getComputedStyle(tile!).borderTopLeftRadius) || 12;
    const from = fromTile(t, box, area, radius);
    animate(el, { x: [from.x, REST.x], y: [from.y, REST.y], scale: [from.scale, REST.scale], clipPath: [from.clipPath, REST.clipPath] }, SPRING);
  }, [box, area, start, tileFor, still]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus starts on Close (and goes back to the tile after).
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>("[data-close]")?.focus({ preventScroll: true });
  }, []);

  const go = (to: number) => {
    const n = photos.length;
    const next = (to + n) % n;
    if (next === i) return;
    setDir(to > i ? 1 : -1);
    setI(next);
    onIndex?.(next);
  };

  const close = () => {
    if (closing) return;
    setClosing(true);
    const el = frameOf(im);
    const tile = tileFor(i);
    const t = tile?.getBoundingClientRect();
    const seen = t && t.bottom > area.top && t.top < area.top + area.height && t.right > area.left && t.left < area.left + area.width;
    const done = () => {
      onClose();
      tile?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    };
    if (!el || !t || !seen || still) return void setTimeout(done, still ? 0 : 140);
    const radius = parseFloat(getComputedStyle(tile!).borderTopLeftRadius) || 12;
    animate(el, fromTile(t, box, area, radius), { ...SPRING, stiffness: 340, damping: 34 }).then(done);
  };

  // The keys always reach the latest go and close.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  useLayoutEffect(() => {
    keys.current = (e) => {
      if (e.key === "Escape" || e.key === " ") close();
      else if (e.key === "ArrowRight") go(i + 1);
      else if (e.key === "ArrowLeft") go(i - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(photos.length - 1);
      else if (e.key === "Tab") {
        // Focus stays in the viewer.
        const all = [...(dialog.current?.querySelectorAll<HTMLElement>("button") ?? [])];
        const at = all.indexOf(document.activeElement as HTMLElement);
        all[(at + (e.shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
      } else return;
      e.preventDefault();
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const middle = TOP + (area.height - TOP - BOTTOM) / 2;
  return createPortal(
    <div
      data-bd-ui=""
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={`${im.alt}, ${i + 1} of ${photos.length}`}
      data-theme="dark"
      className="dark fixed z-[120] overflow-hidden text-white"
      style={{ left: area.left, top: area.top, width: area.width, height: area.height, borderRadius: RADIUS }}
    >
      <motion.div data-bd-ui="" aria-hidden className="absolute inset-0 bg-[rgb(6_6_7/0.94)] backdrop-blur-xl" initial={{ opacity: 0 }} animate={{ opacity: closing ? 0 : 1 }} transition={{ duration: closing ? 0.22 : 0.28 }} onClick={backdropCloses ? close : undefined} />
      {/* The empty top edge moves the window, as a title bar would. */}
      <div data-bd-ui="" data-tauri-drag-region aria-hidden className="absolute inset-x-0 top-0 h-[72px]" />
      {/* Each picture in a frame of its own shape, where it fits. The next one fades in over the last
          where it sits (a breath of movement the way you're going), so neither is cut to the other's shape. */}
      <AnimatePresence initial={false} custom={dir}>
        <motion.div data-bd-ui=""
          key={im.id}
          custom={dir}
          variants={{
            in: (d: number) => ({ opacity: 0, x: still ? 0 : d * 10, scale: still ? 1 : 0.985 }),
            at: { opacity: 1, x: 0, scale: 1 },
            out: (d: number) => ({ opacity: 0, x: still ? 0 : d * -10, scale: 1 }),
          }}
          initial="in"
          animate="at"
          exit="out"
          transition={{ opacity: { duration: 0.24, ease: [0.22, 1, 0.36, 1] }, x: SPRING, scale: SPRING }}
          drag={many && !closing ? "x" : false}
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={0.6}
          onDragEnd={(_, info) => {
            if (info.offset.x < -70 || info.velocity.x < -500) go(i + 1);
            else if (info.offset.x > 70 || info.velocity.x > 500) go(i - 1);
          }}
          className="absolute cursor-grab active:cursor-grabbing"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        >
          {/* The layer that grows out of the tile and shrinks back into it. */}
          <div data-bd-ui="" data-frame={im.id} className="absolute inset-0 overflow-hidden rounded-[14px] bg-[var(--bd-ui-track)] shadow-[0_30px_80px_-20px_rgb(0_0_0/0.8)]">
            <img data-bd-ui="" src={im.preview} alt="" draggable={false} className="absolute inset-0 size-full select-none object-cover" />
            <img
              data-bd-ui=""
              src={im.src}
              alt={im.alt}
              draggable={false}
              onLoad={() => setSharp((s) => ({ ...s, [im.id]: true }))}
              className="absolute inset-0 size-full select-none object-cover transition-opacity duration-300"
              style={{ opacity: sharp[im.id] ? 1 : 0 }}
            />
          </div>
        </motion.div>
      </AnimatePresence>
      <motion.div data-bd-ui="" initial={{ opacity: 0 }} animate={{ opacity: closing ? 0 : 1 }} transition={{ duration: 0.2, delay: closing ? 0 : 0.12 }}>
        {/* Where you are, at the top, level with the buttons. */}
        {many && (
          <span data-bd-ui="" style={{ top: barTop + 6 }} className="absolute left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3.5 py-1.5 text-[13px] font-medium tabular-nums text-white/85 backdrop-blur-xl">
            {(i + 1).toLocaleString()} of {photos.length.toLocaleString()}
          </span>
        )}
        {lead && (
          <div data-bd-ui="" className="absolute flex items-center" style={{ left: leadInset, top: barTop }}>
            {lead(i)}
          </div>
        )}
        <div data-bd-ui="" className="absolute right-4 flex items-center gap-2" style={{ top: barTop }}>
          {actions?.(i)}
          <button data-bd-ui="" type="button" data-close aria-label="Close" onClick={close} className="grid size-10 place-items-center rounded-full bg-white/10 text-white outline-none backdrop-blur-xl transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-white">
            <XIcon weight="regular" className="size-4" />
          </button>
        </div>
        {many && (
          <>
            <button data-bd-ui="" type="button" aria-label="Previous photo" onClick={() => go(i - 1)} className="absolute left-4 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white outline-none backdrop-blur-xl transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-white max-sm:hidden" style={{ top: middle }}>
              <CaretLeftIcon weight="regular" className="size-4" />
            </button>
            <button data-bd-ui="" type="button" aria-label="Next photo" onClick={() => go(i + 1)} className="absolute right-4 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white outline-none backdrop-blur-xl transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-white max-sm:hidden" style={{ top: middle }}>
              <CaretRightIcon weight="regular" className="size-4" />
            </button>
          </>
        )}
        {/* What it is, then the photos around it: the one on screen ringed, the rest a click away. */}
        <div data-bd-ui="" className="absolute inset-x-0 bottom-5 flex flex-col items-center gap-3 px-6">
          {/* One steady line: it changes with the photo, nothing slides or bobs. */}
          <div data-bd-ui="" data-caption className="flex h-5 w-full max-w-[min(960px,100%)] items-center justify-center text-[13px] leading-5 text-white/90">
            {im.caption ?? <span data-bd-ui="" className="min-w-0 truncate">{im.alt}</span>}
          </div>
          {filmstrip && many && <Filmstrip photos={photos} at={i} onPick={go} still={!!still} />}
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}

const STRIP_H = 58;
const STRIP_GAP = 6;
/** How far past each edge thumbnails are kept on the page, so they're there before they glide in. */
const STRIP_SLACK = 240;

/**
 * Every photo has a fixed place along one long row; the row glides on a spring so the one on screen
 * sits in the middle, under a white frame that stays put there (it only eases to each photo's
 * width). Nothing is re-laid out as you move, so it never jumps: only the thumbnails near the window
 * are on the page, and they come and go out of sight, under the faded edges.
 */
function Filmstrip({ photos, at, onPick, still }: { photos: ViewerPhoto[]; at: number; onPick: (i: number) => void; still: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Each thumbnail's width and where it starts along the row.
  const { widths, starts } = useMemo(() => {
    const widths = new Float64Array(photos.length);
    const starts = new Float64Array(photos.length);
    let x = 0;
    photos.forEach((p, k) => {
      const ratio = p.width && p.height ? Math.min(1.6, Math.max(0.62, p.width / p.height)) : 1;
      widths[k] = Math.round(STRIP_H * ratio);
      starts[k] = x;
      x += widths[k] + STRIP_GAP;
    });
    return { widths, starts };
  }, [photos]);

  const offset = width / 2 - (starts[at] + widths[at] / 2);
  const from = -offset - STRIP_SLACK;
  const to = -offset + width + STRIP_SLACK;
  const visible: number[] = [];
  for (let k = at; k >= 0 && starts[k] + widths[k] >= from; k--) visible.push(k);
  for (let k = at + 1; k < photos.length && starts[k] <= to; k++) visible.push(k);

  return (
    <div
      data-bd-ui=""
      ref={box}
      className="relative w-full max-w-[min(1100px,100%)] overflow-hidden"
      style={{ height: STRIP_H + 14, maskImage: "linear-gradient(90deg, transparent, #000 9%, #000 91%, transparent)" }}
    >
      {width > 0 && (
        <motion.div data-bd-ui="" className="absolute inset-y-0 left-0" initial={false} animate={{ x: offset }} transition={still ? { duration: 0 } : GLIDE}>
          {visible.map((k) => {
            const p = photos[k];
            const on = k === at;
            return (
              <button data-bd-ui=""
                key={p.id}
                type="button"
                data-current={on ? "" : undefined}
                aria-label={`${p.alt}, ${k + 1} of ${photos.length}`}
                aria-current={on ? "true" : undefined}
                onClick={() => onPick(k)}
                className={cx(
                  "absolute top-[7px] overflow-hidden rounded-[7px] bg-white/5 outline-none transition-opacity duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] focus-visible:outline-2 focus-visible:outline-white",
                  on ? "opacity-100" : "opacity-45 hover:opacity-90",
                )}
                style={{ left: starts[k], width: widths[k], height: STRIP_H }}
              >
                <img data-bd-ui="" src={p.thumb} alt="" loading="lazy" draggable={false} className="size-full object-cover" />
              </button>
            );
          })}
        </motion.div>
      )}
      {/* The frame: fixed in the middle; the photos slide into it. */}
      {width > 0 && (
        <motion.div
          data-bd-ui=""
          data-frame-ring=""
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-[3px] rounded-[10px] shadow-[inset_0_0_0_2px_#fff,0_0_0_1px_rgb(0_0_0/0.35)]"
          style={{ height: STRIP_H + 8, translateX: "-50%" }}
          initial={false}
          animate={{ width: widths[at] + 8 }}
          transition={still ? { duration: 0 } : GLIDE}
        />
      )}
    </div>
  );
}
