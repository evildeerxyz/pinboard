import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger, toast } from '@basedraft/ui';
import {
  ArrowClockwiseIcon,
  CaretUpDownIcon,
  DownloadSimpleIcon,
  EyeSlashIcon,
  FilmSlateIcon,
  FolderOpenIcon,
  FolderSimpleIcon,
  GearSixIcon,
  ImagesSquareIcon,
  MagnifyingGlassIcon,
  MusicNotesIcon,
  PictureInPictureIcon,
  VideoCameraIcon,
  type Icon,
} from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { memo, useState, type ReactNode } from 'react';
import { revealFolder } from '../lib/api';
import { count, type FolderNode } from '../lib/library';
import { Tip } from './Tip';

export type NavItem = { id: string; label: string; icon: Icon; badge?: string; hidden?: boolean };

/** Folders at the top of your home folder get a colored square with a white icon, like pinned boards. Every color is deep enough for white to read on it. */
const PLACES: Record<string, { icon: Icon; color: string }> = {
  Downloads: { icon: DownloadSimpleIcon, color: '#4f8df7' },
  Desktop: { icon: PictureInPictureIcon, color: '#3ec46d' },
  Documents: { icon: FolderSimpleIcon, color: '#f2a93b' },
  Pictures: { icon: ImagesSquareIcon, color: '#22b35e' },
  Movies: { icon: VideoCameraIcon, color: '#f26b5b' },
  Music: { icon: MusicNotesIcon, color: '#e05ad8' },
};
const OTHER_COLORS = ['#f26b5b', '#9b7bf5', '#14a9c4', '#e8a512', '#f25c78'];

export function PlaceSquare({ name, size = 22, round }: { name: string; size?: number; round?: boolean }) {
  // Own keys only: a folder called "constructor" or "toString" mustn't pick up something built in.
  const place = (Object.hasOwn(PLACES, name) ? PLACES[name] : undefined) ?? { icon: FilmSlateIcon, color: OTHER_COLORS[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % OTHER_COLORS.length] };
  const I = place.icon;
  return (
    <span className={`grid shrink-0 place-items-center text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.3)] [&_svg]:drop-shadow-[0_0.5px_0.5px_rgb(0_0_0/0.25)] ${round ? 'rounded-full' : 'rounded-[6px]'}`} style={{ width: size, height: size, background: place.color }}>
      <I weight="bold" style={{ width: size * 0.6, height: size * 0.6 }} />
    </span>
  );
}

const row = 'relative flex w-full items-center gap-3 rounded-[9px] text-left outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white/40';

export const Sidebar = memo(function Sidebar({
  appName,
  appIcon,
  nav,
  folders,
  active,
  onSelect,
  onSearch,
  onRefresh,
  onHide,
  refreshing,
  status,
}: {
  appName: string;
  /** Shown in full screen, where the traffic lights would be. */
  appIcon?: string;
  nav: NavItem[];
  folders: FolderNode[];
  active: string;
  onSelect: (id: string) => void;
  onSearch: () => void;
  onRefresh: () => void;
  /** Leave a folder out of Pinboard (Settings brings it back). */
  onHide: (path: string) => void;
  refreshing: boolean;
  status: ReactNode;
}) {
  return (
    <aside className="flex h-full w-[272px] shrink-0 flex-col">
      {/* The app's name, beside the window's traffic lights (its icon in their place in full screen). */}
      <div data-tauri-drag-region className={`flex h-[64px] shrink-0 items-center gap-2.5 border-b border-white/[0.07] pr-3 ${appIcon ? 'pl-[20px]' : 'pl-[96px]'}`}>
        {appIcon && <img src={appIcon} alt="" draggable={false} className="size-[26px] shrink-0 rounded-[7px] shadow-[0_1px_3px_rgb(0_0_0/0.4)]" />}
        <span data-tauri-drag-region className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-[#f4f4f5]">{appName}</span>
      </div>

      <button type="button" onClick={onSearch} className="flex h-[52px] shrink-0 items-center gap-3 border-b border-white/[0.07] px-[22px] text-white/50 transition-colors hover:text-white/80">
        <MagnifyingGlassIcon className="size-[18px]" />
        <span className="flex-1 text-left text-[15px]">Search</span>
        <span className="rounded-[7px] border border-white/[0.1] bg-white/[0.06] px-2 py-[3px] text-[12px] tracking-wide text-white/55">⌘ + K</span>
      </button>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3">
        <nav aria-label="Library" className="flex flex-col gap-[3px]">
          {nav.filter((n) => !n.hidden).map((n) => (
            <NavRow key={n.id} item={n} active={active === n.id} onSelect={onSelect} />
          ))}
        </nav>

        <div className="mt-6 flex items-center justify-between pl-3 pr-1.5">
          <h2 className="text-[15px] text-white/50">Folders</h2>
          <Tip content="Look for new pictures">
            <button type="button" onClick={onRefresh} disabled={refreshing} aria-label="Look for new pictures" className="grid size-7 place-items-center rounded-lg text-white/50 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-60">
              <ArrowClockwiseIcon className={`size-[17px] ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </Tip>
        </div>
        <div className="mt-2 flex flex-col gap-[2px]" role="tree" aria-label="Folders">
          {folders.map((f) => (
            <Place key={f.path} node={f} active={active} onSelect={onSelect} onHide={onHide} />
          ))}
          {!folders.length && <p className="px-3 py-2 text-[13px] text-white/40">Folders with pictures appear here.</p>}
        </div>
      </div>

      <div className="shrink-0 border-t border-white/[0.07] px-3 pb-3 pt-2">
        <NavRow item={SETTINGS} active={active === 'settings'} onSelect={onSelect} />
        <p className="truncate px-3 pt-1.5 text-[12px] tabular-nums text-white/40">{status}</p>
      </div>
    </aside>
  );
});

const SETTINGS: NavItem = { id: 'settings', label: 'Settings', icon: GearSixIcon };

/** Right-click a folder: show it in Finder, or leave it out of Pinboard. */
function FolderMenu({ path, label, onHide, children }: { path: string; label: string; onHide: (path: string) => void; children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger tabIndex={-1} aria-label={label} className="outline-none">
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent label={label}>
        <ContextMenuItem icon={<FolderOpenIcon />} onSelect={() => void revealFolder(path).catch((e) => toast("Couldn't show it in Finder", { description: String(e), tone: 'stop' }))}>
          Show in Finder
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem icon={<EyeSlashIcon />} onSelect={() => onHide(path)}>
          Hide from Pinboard
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The page you're on sits on a dark pill with an edge, which slides to the next. */
function Selected() {
  return <motion.span layoutId="sidebar-selected" transition={{ type: 'spring', stiffness: 520, damping: 42 }} className="absolute inset-0 rounded-[9px] border border-white/[0.1] bg-white/[0.07] shadow-[0_1px_2px_rgb(0_0_0/0.25)]" />;
}

function NavRow({ item, active, onSelect }: { item: NavItem; active: boolean; onSelect: (id: string) => void }) {
  const I = item.icon;
  return (
    <button type="button" onClick={() => onSelect(item.id)} aria-current={active ? 'page' : undefined} className={`${row} h-[40px] px-3 ${active ? 'text-white' : 'text-[#e4e4e7] hover:bg-white/[0.05]'}`}>
      {active && <Selected />}
      <I weight="regular" className="relative size-[19px] shrink-0 text-[#d4d4d8]" />
      <span className="relative flex-1 truncate text-[15px]">{item.label}</span>
      {item.badge && (
        <span className="relative rounded-full border border-white/[0.12] px-2 py-[1px] text-[12.5px] text-white/55">
          {item.badge}
          <span className="absolute -right-0.5 -top-0.5 size-[7px] rounded-full bg-[#ff4d5e]" />
        </span>
      )}
    </button>
  );
}

/** A folder at the top of the home folder, with what's in it a level or two down. */
type FolderProps = { node: FolderNode; active: string; onSelect: (id: string) => void; onHide: (path: string) => void };

function Place({ node, active, onSelect, onHide }: FolderProps) {
  const [open, setOpen] = useState(true);
  const id = `folder:${node.path}`;
  return (
    <div role="treeitem" aria-expanded={node.children.length ? open : undefined} aria-selected={active === id}>
      <FolderMenu path={node.path} label={node.label} onHide={onHide}>
      <div className="group/place relative flex items-center">
        <button type="button" onClick={() => onSelect(id)} className={`${row} h-[40px] pl-3 pr-16 ${active === id ? 'text-white' : 'text-[#ededf0] hover:bg-white/[0.05]'}`}>
          {active === id && <Selected />}
          <span className="relative"><PlaceSquare name={node.path.split('/')[0]} /></span>
          <span className="relative min-w-0 flex-1 truncate text-[15px]">{node.label}</span>
        </button>
        <span className="pointer-events-none absolute right-9 text-[12px] tabular-nums text-white/40 opacity-0 transition-opacity group-hover/place:opacity-100">{count(node.count)}</span>
        {node.children.length > 0 && (
          <button type="button" onClick={() => setOpen(!open)} aria-label={open ? `Close ${node.label}` : `Open ${node.label}`} className="absolute right-1.5 grid size-7 place-items-center rounded-md text-white/50 hover:bg-white/5 hover:text-white">
            <CaretUpDownIcon className="size-[15px]" />
          </button>
        )}
      </div>
      </FolderMenu>
      <AnimatePresence initial={false}>
        {open && node.children.length > 0 && (
          <Reveal>
            <div role="group" className="flex flex-col gap-[1px] pb-1">
              {node.children.map((c) => (
                <SubFolder key={c.path} node={c} active={active} onSelect={onSelect} onHide={onHide} />
              ))}
            </div>
          </Reveal>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A folder one level in: a quiet icon, and the folders inside it on a guide line. */
function SubFolder({ node, active, onSelect, onHide }: FolderProps) {
  const id = `folder:${node.path}`;
  const within = active.startsWith(id + '/');
  const [open, setOpen] = useState(false);
  const shown = open || within;
  const choose = () => {
    onSelect(id);
    if (node.children.length) setOpen(true);
  };
  return (
    <div role="treeitem" aria-expanded={node.children.length ? shown : undefined} aria-selected={active === id}>
      <FolderMenu path={node.path} label={node.label} onHide={onHide}>
      <div className="group/sub relative flex items-center">
        <button type="button" onClick={choose} className={`${row} h-[36px] pl-[22px] pr-12 ${active === id ? 'text-white' : 'text-[#e4e4e7] hover:bg-white/[0.05]'}`}>
          {active === id && <Selected />}
          <FolderSimpleIcon className="relative size-[17px] shrink-0 text-[#a1a1aa]" />
          <span className="relative min-w-0 flex-1 truncate text-[15px]">{node.label}</span>
        </button>
        <span className="pointer-events-none absolute right-3 text-[12px] tabular-nums text-white/40 opacity-0 transition-opacity group-hover/sub:opacity-100">{count(node.count)}</span>
      </div>
      </FolderMenu>
      <AnimatePresence initial={false}>
      {shown && node.children.length > 0 && (
        <Reveal>
        <div role="group" className="relative ml-[31px] flex flex-col border-l border-white/[0.12] py-0.5 pl-1">
          {node.children.slice(0, 40).map((c) => {
            const cid = `folder:${c.path}`;
            return (
              <FolderMenu key={c.path} path={c.path} label={c.label} onHide={onHide}>
                <button type="button" role="treeitem" aria-selected={active === cid} onClick={() => onSelect(cid)} className={`${row} h-[33px] px-3 ${active === cid ? 'text-white' : 'text-[#c4c4c9] hover:bg-white/[0.05] hover:text-white'}`}>
                  {active === cid && <Selected />}
                  <span className="relative min-w-0 flex-1 truncate text-[14.5px]">{c.label}</span>
                </button>
              </FolderMenu>
            );
          })}
        </div>
        </Reveal>
      )}
      </AnimatePresence>
    </div>
  );
}

/** What's inside a folder, opening and closing to its own height. */
function Reveal({ children }: { children: ReactNode }) {
  return (
    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 38 }} className="overflow-hidden">
      {children}
    </motion.div>
  );
}


