import { convertFileSrc, invoke } from '@tauri-apps/api/core';

export type Photo = {
  id: string;
  path: string;
  name: string;
  /** Relative to the home folder, like "Downloads/Trip". */
  folder: string;
  width: number;
  height: number;
  screenshot: boolean;
  camera: string | null;
  /** When it was taken or made, ms since 1970. */
  taken: number;
  modified: number;
  bytes: number;
  ext: string;
};

/** Every picture, and the guarded folders (Downloads, Desktop, Documents) macOS didn't let it look in. */
export const scanLibrary = (options: { skipCode: boolean; skipSmall: boolean }) => invoke<{ photos: Photo[]; blocked: string[] }>('scan_library', { options });
export const openPrivacySettings = () => invoke('open_privacy_settings');
export const reveal = (id: string) => invoke('reveal', { id });
export const openPhoto = (id: string) => invoke('open_photo', { id });
export const copyPhoto = (id: string) => invoke('copy_photo', { id });
/** The same, for several pictures at once. */
export const revealPhotos = (ids: string[]) => invoke('reveal_photos', { ids });
export const openPhotos = (ids: string[]) => invoke('open_photos', { ids });
export const copyPhotos = (ids: string[]) => invoke('copy_photos', { ids });

/** A picture moved to the Trash, with where it went, to put it back. */
export type Trashed = { id: string; from: string; to: string; modified: number };
/** Moves pictures to the Trash (never deletes them); `failed` are the ids that couldn't go. */
export const trashPhotos = (ids: string[]) => invoke<{ trashed: Trashed[]; failed: string[] }>('trash', { ids });
/** Undo: puts them back where they were. The ids that went back. */
export const putBack = (items: Trashed[]) => invoke<string[]>('put_back', { items });

/** Opens a folder (relative to the home folder) in Finder. */
export const revealFolder = (folder: string) => invoke('reveal_folder', { folder });

/** A thumbnail made by macOS (ImageIO) and cached: 256, 512, 1024 or 2048 pixels on its long side. */
export const thumbUrl = (id: string, size: number) => `${convertFileSrc(id, 'thumb')}?s=${size}`;
