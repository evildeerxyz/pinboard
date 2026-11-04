import type { Photo } from './api';

/* ---------- what each picture is ---------- */

const CAMERA_EXTS = new Set(['heic', 'heif', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'srw', 'pef']);
const SCREENSHOT_NAME = /^(screenshot|screen shot|cleanshot|frameclip|simulator screen shot|screen recording)/i;
/** "frame_0001.png", "0042.jpg", "img-00012.png": one frame of many. */
const FRAME_NAME = /^[^\d]{0,12}\d{3,}\.[a-z0-9]+$/i;

export type Kind = { screenshot: boolean; camera: boolean; frame: boolean; animated: boolean };

/**
 * Video frames: a folder of a hundred or more pictures nearly all named like numbered frames.
 * They'd fill All Photos with near-identical shots, so they get a category of their own.
 */
export function frameFolders(photos: Photo[]): Set<string> {
  const byFolder = new Map<string, { all: number; frames: number }>();
  for (const p of photos) {
    const f = byFolder.get(p.folder) ?? { all: 0, frames: 0 };
    f.all++;
    if (FRAME_NAME.test(p.name)) f.frames++;
    byFolder.set(p.folder, f);
  }
  const out = new Set<string>();
  for (const [folder, f] of byFolder) if (f.all >= 100 && f.frames / f.all >= 0.8) out.add(folder);
  return out;
}

export function kindOf(p: Photo, frames: Set<string>): Kind {
  return {
    screenshot: p.screenshot || SCREENSHOT_NAME.test(p.name),
    camera: !!p.camera || CAMERA_EXTS.has(p.ext),
    frame: frames.has(p.folder),
    animated: p.ext === 'gif',
  };
}

export type Indexed = Photo & { kind: Kind };

export function classify(photos: Photo[]): Indexed[] {
  const frames = frameFolders(photos);
  return photos.map((p) => ({ ...p, kind: kindOf(p, frames) }));
}

/* ---------- the library's smart categories ---------- */

const DAY = 86_400_000;

export type CategoryId = 'all' | 'recent' | 'favorites' | 'screenshots' | 'camera' | 'frames';

export type Category = { id: CategoryId; label: string; test: (p: Indexed, favorites: Set<string>) => boolean };

export const CATEGORIES: Category[] = [
  { id: 'all', label: 'All Photos', test: (p) => !p.kind.frame },
  { id: 'recent', label: 'Recent', test: (p) => !p.kind.frame && Date.now() - p.taken < 30 * DAY },
  { id: 'favorites', label: 'Favorites', test: (p, fav) => fav.has(p.id) },
  { id: 'screenshots', label: 'Screenshots', test: (p) => p.kind.screenshot },
  { id: 'camera', label: 'Camera', test: (p) => p.kind.camera && !p.kind.frame },
  { id: 'frames', label: 'Video Frames', test: (p) => p.kind.frame },
];

/* ---------- folders, for the sidebar ---------- */

export type FolderNode = {
  /** Path relative to home, like "Pictures/Travel". */
  path: string;
  /** Its name, or a few names joined when folders hold nothing but one folder each. */
  label: string;
  /** Pictures in it and everything under it. */
  count: number;
  children: FolderNode[];
};

/** Folders that hold pictures, nested, with single-folder chains joined ("Travel / Lisbon"). */
export function folderTree(photos: Photo[], maxDepth = 4): FolderNode[] {
  type Raw = { name: string; path: string; own: number; total: number; kids: Map<string, Raw> };
  const root: Raw = { name: '', path: '', own: 0, total: 0, kids: new Map() };
  for (const p of photos) {
    if (!p.folder) continue;
    let at = root;
    at.total++;
    const parts = p.folder.split('/');
    parts.forEach((name, i) => {
      let next = at.kids.get(name);
      if (!next) {
        next = { name, path: parts.slice(0, i + 1).join('/'), own: 0, total: 0, kids: new Map() };
        at.kids.set(name, next);
      }
      next.total++;
      at = next;
    });
    at.own++;
  }
  const build = (raw: Raw, depth: number): FolderNode => {
    let node = raw;
    let label = raw.name;
    // Join a folder that holds no pictures of its own and only one folder.
    while (node.own === 0 && node.kids.size === 1) {
      node = [...node.kids.values()][0];
      label += ` / ${node.name}`;
    }
    const children = depth >= maxDepth ? [] : [...node.kids.values()].sort((a, b) => b.total - a.total).map((k) => build(k, depth + 1));
    return { path: node.path, label, count: raw.total, children };
  };
  return [...root.kids.values()].sort((a, b) => b.total - a.total).map((k) => build(k, 1));
}

export function inFolder(p: Photo, folder: string) {
  return p.folder === folder || p.folder.startsWith(folder + '/');
}

/** The folders a palette can jump to: every node of the tree, flattened. */
export function flattenFolders(nodes: FolderNode[], out: FolderNode[] = []): FolderNode[] {
  for (const n of nodes) {
    out.push(n);
    flattenFolders(n.children, out);
  }
  return out;
}

/* ---------- search and filters ---------- */

const MONTH_NAME = new Intl.DateTimeFormat(undefined, { month: 'long' });

/** Every word must appear in the name, folder, camera, file type or month and year. */
export function matches(p: Indexed, words: string[]) {
  if (!words.length) return true;
  const d = new Date(p.taken);
  const hay = `${p.name} ${p.folder} ${p.camera ?? ''} ${p.ext} ${MONTH_NAME.format(d)} ${d.getFullYear()} ${p.kind.screenshot ? 'screenshot' : ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export type Shape = 'portrait' | 'landscape' | 'square';

export function shapeOf(p: Photo): Shape {
  if (!p.width || !p.height) return 'square';
  const r = p.width / p.height;
  return r > 1.15 ? 'landscape' : r < 0.87 ? 'portrait' : 'square';
}

/** What you can narrow a view to, in groups: any one in a group will do, and every group with one on must match. */
export const FILTER_GROUPS = [
  { id: 'shape', label: 'Shape' },
  { id: 'kind', label: 'Kind' },
  { id: 'format', label: 'Format' },
] as const;
export const FILTERS = [
  { value: 'portrait', group: 'shape', label: 'Portrait', test: (p: Indexed) => shapeOf(p) === 'portrait' },
  { value: 'landscape', group: 'shape', label: 'Landscape', test: (p: Indexed) => shapeOf(p) === 'landscape' },
  { value: 'square', group: 'shape', label: 'Square', test: (p: Indexed) => shapeOf(p) === 'square' },
  { value: 'screenshots', group: 'kind', label: 'Screenshots', test: (p: Indexed) => p.kind.screenshot },
  { value: 'camera', group: 'kind', label: 'Camera', test: (p: Indexed) => p.kind.camera },
  { value: 'gif', group: 'kind', label: 'GIFs', test: (p: Indexed) => p.kind.animated },
  { value: 'png', group: 'format', label: 'PNG', test: (p: Indexed) => p.ext === 'png' },
  { value: 'jpeg', group: 'format', label: 'JPEG', test: (p: Indexed) => p.ext === 'jpg' || p.ext === 'jpeg' },
] as const;

/* ---------- small formats ---------- */

const NUMBER = new Intl.NumberFormat();
export const count = (n: number) => NUMBER.format(n);
/** "1 picture", "9,887 pictures". */
export const pictures = (n: number) => `${NUMBER.format(n)} ${n === 1 ? 'picture' : 'pictures'}`;
const DATE = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
export const dateOf = (ms: number) => DATE.format(new Date(ms));
export function sizeOf(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
