import { AnimatePresence, motion } from 'motion/react';
import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A tooltip that floats above everything (in its own layer, not inside the panel it's in), so no
 * rounded panel or sidebar can cut it off, and that keeps itself inside the window.
 */
export function Tip({ content, keys, side = 'bottom', children }: { content: ReactNode; keys?: string[]; side?: 'top' | 'bottom'; children: ReactElement }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const id = useId();
  const [shift, setShift] = useState(0);

  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = anchor.current?.getBoundingClientRect();
      if (r) setAt({ x: r.left + r.width / 2, y: side === 'bottom' ? r.bottom + 8 : r.top - 8 });
    }, 320);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setAt(null);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  // Nudged sideways to stay at least 8 px inside the window.
  useEffect(() => {
    const b = bubble.current?.getBoundingClientRect();
    if (!b || !at) return setShift(0);
    const half = b.width / 2;
    setShift(Math.max(8 + half - at.x, Math.min(0, innerWidth - 8 - half - at.x)));
  }, [at]);

  const trigger = isValidElement<{ 'aria-describedby'?: string }>(children) ? cloneElement(children, { 'aria-describedby': at ? id : undefined }) : children;
  return (
    <span ref={anchor} className="inline-flex" onPointerEnter={show} onPointerLeave={hide} onPointerDown={hide} onFocus={show} onBlur={hide}>
      {trigger}
      {createPortal(
        <AnimatePresence>
          {at && (
            <motion.div
              ref={bubble}
              id={id}
              role="tooltip"
              initial={{ opacity: 0, y: side === 'bottom' ? -3 : 3, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              transition={{ type: 'spring', stiffness: 600, damping: 38 }}
              className="pointer-events-none fixed z-[200] flex items-center gap-2 whitespace-nowrap rounded-[9px] border border-white/10 bg-[rgb(28_28_31/0.96)] px-2.5 py-1.5 text-[12.5px] text-white shadow-[0_8px_24px_-6px_rgb(0_0_0/0.6)] backdrop-blur-xl"
              style={{ left: at.x + shift, top: at.y, translate: side === 'bottom' ? '-50% 0' : '-50% -100%' }}
            >
              {content}
              {keys && (
                <span className="flex gap-0.5">
                  {keys.map((k) => (
                    <span key={k} className="grid min-w-[17px] place-items-center rounded-[4px] bg-white/10 px-1 text-[11px] text-white/70">
                      {k}
                    </span>
                  ))}
                </span>
              )}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </span>
  );
}
