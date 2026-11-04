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
  /** Its size is only known roughly (from a thumbnail), so it isn't shown. */
  approx?: boolean;
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

/** Moves pictures to the Trash (never deletes them): the ids that went, and the ids that couldn't. */
export const trashPhotos = (ids: string[]) => invoke<{ trashed: string[]; failed: string[] }>('trash', { ids });
/** Undo: puts pictures Pinboard moved to the Trash back where they were. The ids that went back. */
export const putBack = (ids: string[]) => invoke<string[]>('put_back', { ids });

/** Pictures Finder asked Pinboard to open (a double-click, Open With): their ids, in order, and
 * records for any the scan doesn't list. Each is handed over once. */
export const takeOpened = () => invoke<{ ids: string[]; extra: Photo[]; cold: boolean }>('take_opened');
/** Puts the window away (closing a picture opened from Finder); the Dock icon brings it back. */
export const hideWindow = () => invoke('hide_window');
/** Whether pictures open in Pinboard from Finder, and changing that (off goes back to Preview). */
export const isDefaultViewer = () => invoke<boolean>('is_default_viewer');
export const setDefaultViewer = (on: boolean) => invoke('set_default_viewer', { on });

/** Opens a folder (relative to the home folder) in Finder. */
export const revealFolder = (folder: string) => invoke('reveal_folder', { folder });

/** A thumbnail made by macOS (ImageIO) and cached: 256, 512, 1024 or 2048 pixels on its long side. */
export const thumbUrl = (id: string, size: number) => `${convertFileSrc(id, 'thumb')}?s=${size}`;
