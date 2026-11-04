mod index;
mod thumbs;

use index::Photo;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{NSPasteboard, NSPasteboardWriting, NSWorkspace};
use objc2_foundation::{NSArray, NSFileManager, NSString, NSURL};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, RwLock};
use tauri::http::{header, Response, StatusCode};
use tauri::{Manager, State};
use tokio::sync::Semaphore;

/// What the window may look at: the indexed pictures, by id. Thumbnails and Finder actions only
/// ever reach files in here, never an arbitrary path: the window can't name a file of its own.
#[derive(Default)]
struct Library {
    photos: RwLock<HashMap<String, Entry>>,
    /// What `trash` moved, by id, so Undo can only put back those files, to where they were.
    trashed: Mutex<HashMap<String, Trashed>>,
    /// Thumbnails Quick Look couldn't make (id, size and modification time), so they aren't asked for again.
    failed: Mutex<HashSet<String>>,
}

/// An indexed picture: where it is, when it last changed, and how many pixels Spotlight says it has.
#[derive(Clone)]
struct Entry {
    path: PathBuf,
    modified: i64,
    pixels: u64,
}

/// Pictures bigger than this aren't thumbnailed: a small file can unpack into gigabytes.
const MAX_PIXELS: u64 = 250_000_000;

/// The most pictures Open sends to other apps at once.
const OPEN_AT_MOST: usize = 50;

/// Ids are 16 lowercase hex digits (a hash of the path). Anything else is refused before it can
/// go near a file name.
fn valid_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "No home folder".into())
}

/// At most this many thumbnails are made at once, so scrolling fast never pins every core.
const THUMB_WORKERS: usize = 3;

/// Folders macOS guards: until you allow it, Spotlight quietly leaves their pictures out.
const GUARDED: [&str; 3] = ["Downloads", "Desktop", "Documents"];

#[derive(serde::Serialize)]
struct Scan {
    photos: Vec<Photo>,
    /// Guarded folders Pinboard wasn't allowed to look in.
    blocked: Vec<String>,
}

#[tauri::command]
async fn scan_library(options: Option<index::ScanOptions>, library: State<'_, Arc<Library>>) -> Result<Scan, String> {
    let options = options.unwrap_or_default();
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("No home folder")?;
    let scan = tauri::async_runtime::spawn_blocking(move || {
        // Looking inside a guarded folder is what makes macOS ask "Allow access?" (and wait for the
        // answer); only after that does Spotlight include it.
        let blocked = GUARDED.iter().filter(|f| home.join(f).is_dir() && std::fs::read_dir(home.join(f)).is_err()).map(|f| f.to_string()).collect();
        Scan { photos: index::scan_with(&home, options), blocked }
    })
    .await
    .map_err(|e| e.to_string())?;
    let map = scan.photos.iter().map(|p| (p.id.clone(), Entry { path: PathBuf::from(&p.path), modified: p.modified, pixels: p.width as u64 * p.height as u64 })).collect();
    *library.photos.write().unwrap() = map;
    Ok(scan)
}

fn thumb_cache(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_cache_dir().map(|d| d.join("thumbnails")).unwrap_or_else(|_| std::env::temp_dir().join("pinboard-thumbnails"))
}

/// How much room the thumbnails take, in bytes.
#[tauri::command]
fn cache_size(app: tauri::AppHandle) -> u64 {
    std::fs::read_dir(thumb_cache(&app)).map(|d| d.flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum()).unwrap_or(0)
}

/// Deletes every thumbnail; they're made again as pictures come into view.
#[tauri::command]
fn clear_cache(app: tauri::AppHandle) -> Result<(), String> {
    let dir = thumb_cache(&app);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Shows a folder of the library in a Finder window. Only a folder that holds indexed pictures, and
/// only by showing it: never by opening it, which would launch an app bundle or an installer.
#[tauri::command]
fn reveal_folder(folder: String, library: State<'_, Arc<Library>>) -> Result<(), String> {
    let path = library_folder(&library, &folder, &home()?)?;
    if NSWorkspace::sharedWorkspace().selectFile_inFileViewerRootedAtPath(None, &NSString::from_str(&path.to_string_lossy())) {
        Ok(())
    } else {
        Err("Finder couldn't show that folder.".into())
    }
}

/// A folder of the home folder, by its path inside it, that holds pictures in the library and
/// really is inside the home folder (no `..`, and no link leading out of it).
fn library_folder(library: &Library, folder: &str, home: &Path) -> Result<PathBuf, String> {
    let refused = || "That isn't a folder of the library.".to_string();
    if folder.is_empty() || folder.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return Err(refused());
    }
    let path = home.join(folder);
    if !library.photos.read().unwrap().values().any(|e| e.path.starts_with(&path)) {
        return Err(refused());
    }
    let real = path.canonicalize().map_err(|_| "That folder isn't there any more.".to_string())?;
    let real_home = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    if real.starts_with(&real_home) && real.is_dir() {
        Ok(real)
    } else {
        Err(refused())
    }
}

/// System Settings › Privacy & Security › Files and Folders.
#[tauri::command]
fn open_privacy_settings() -> Result<(), String> {
    Command::new("/usr/bin/open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders").status().map_err(|e| e.to_string())?;
    Ok(())
}

fn indexed_path(library: &Library, id: &str) -> Result<PathBuf, String> {
    library.photos.read().unwrap().get(id).map(|e| e.path.clone()).ok_or_else(|| "That picture isn't in the library any more.".into())
}

/// The indexed pictures among these ids (any that have gone are left out).
fn indexed_paths(library: &Library, ids: &[String]) -> Result<Vec<PathBuf>, String> {
    let photos = library.photos.read().unwrap();
    let paths: Vec<PathBuf> = ids.iter().filter_map(|id| photos.get(id).map(|e| e.path.clone())).collect();
    if paths.is_empty() {
        Err("Those pictures aren't in the library any more.".into())
    } else {
        Ok(paths)
    }
}

fn file_url(path: &Path) -> Retained<NSURL> {
    NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
}

/// Shows the picture in Finder, selected.
#[tauri::command]
fn reveal(id: String, library: State<'_, Arc<Library>>) -> Result<(), String> {
    let path = indexed_path(&library, &id)?;
    Command::new("/usr/bin/open").arg("-R").arg(path).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// Shows several pictures in Finder, all selected (a window for each folder they're in).
#[tauri::command]
fn reveal_photos(ids: Vec<String>, library: State<'_, Arc<Library>>) -> Result<(), String> {
    let urls: Vec<Retained<NSURL>> = indexed_paths(&library, &ids)?.iter().map(|p| file_url(p)).collect();
    NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&NSArray::from_retained_slice(&urls));
    Ok(())
}

/// Opens several pictures in their usual apps at once.
#[tauri::command]
fn open_photos(ids: Vec<String>, library: State<'_, Arc<Library>>) -> Result<(), String> {
    if ids.len() > OPEN_AT_MOST {
        return Err(format!("Pinboard opens at most {OPEN_AT_MOST} pictures at once."));
    }
    let paths = indexed_paths(&library, &ids)?;
    Command::new("/usr/bin/open").args(&paths).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// A picture moved to the Trash: where it was, and where it went, so it can be put back. Kept here
/// only, never taken from the window.
struct Trashed {
    entry: Entry,
    to: PathBuf,
}

#[derive(serde::Serialize)]
struct TrashResult {
    /// Ids that went to the Trash.
    trashed: Vec<String>,
    /// Ids that couldn't be moved (gone already, or not allowed).
    failed: Vec<String>,
}

/// Moves pictures to the Trash, the way Finder does: nothing is deleted, and Put Back in Finder
/// (or Undo here) brings them back. Each is tried on its own, so one that can't go doesn't stop the rest.
#[tauri::command]
fn trash(ids: Vec<String>, library: State<'_, Arc<Library>>) -> TrashResult {
    trash_ids(&library, ids)
}

fn trash_ids(library: &Library, ids: Vec<String>) -> TrashResult {
    let files = NSFileManager::defaultManager();
    let mut result = TrashResult { trashed: Vec::new(), failed: Vec::new() };
    for id in ids {
        let Some(entry) = library.photos.read().unwrap().get(&id).cloned() else {
            result.failed.push(id);
            continue;
        };
        let mut went: Option<Retained<NSURL>> = None;
        match files.trashItemAtURL_resultingItemURL_error(&file_url(&entry.path), Some(&mut went)) {
            Ok(()) => {
                library.photos.write().unwrap().remove(&id);
                if let Some(to) = went.and_then(|u| u.path()).map(|p| PathBuf::from(p.to_string())) {
                    library.trashed.lock().unwrap().insert(id.clone(), Trashed { entry, to });
                }
                result.trashed.push(id);
            }
            Err(_) => result.failed.push(id),
        }
    }
    result
}

/// Undo for `trash`: puts pictures back where they were. The window only names ids; where each
/// file went and where it goes back to are the ones `trash` recorded, so nothing else can be moved.
/// Never over a file that's there now, and only into its folder if that's still there.
#[tauri::command]
fn put_back(ids: Vec<String>, library: State<'_, Arc<Library>>) -> Vec<String> {
    put_back_ids(&library, ids)
}

/// The ids of the pictures that went back.
fn put_back_ids(library: &Library, ids: Vec<String>) -> Vec<String> {
    let mut back = Vec::new();
    for id in ids {
        let Some(t) = library.trashed.lock().unwrap().remove(&id) else { continue };
        let from = &t.entry.path;
        if t.to.is_file() && from.parent().is_some_and(|p| p.is_dir()) && !from.exists() && std::fs::rename(&t.to, from).is_ok() {
            library.photos.write().unwrap().insert(id.clone(), t.entry);
            back.push(id);
        }
    }
    back
}

/// Opens the picture in its usual app (Preview, Photoshop…).
#[tauri::command]
fn open_photo(id: String, library: State<'_, Arc<Library>>) -> Result<(), String> {
    let path = indexed_path(&library, &id)?;
    Command::new("/usr/bin/open").arg(path).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// Puts the pictures' files on the clipboard, so they paste into Messages, Mail or Finder.
#[tauri::command]
fn copy_photos(ids: Vec<String>, library: State<'_, Arc<Library>>) -> Result<(), String> {
    let files: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = indexed_paths(&library, &ids)?.iter().map(|p| ProtocolObject::from_retained(file_url(p))).collect();
    let board = NSPasteboard::generalPasteboard();
    board.clearContents();
    if board.writeObjects(&NSArray::from_retained_slice(&files)) {
        Ok(())
    } else {
        Err("Couldn't copy them.".into())
    }
}

/// Puts one picture's file on the clipboard.
#[tauri::command]
fn copy_photo(id: String, library: State<'_, Arc<Library>>) -> Result<(), String> {
    copy_photos(vec![id], library)
}

fn respond(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        // Thumbnails never change for a given URL (the file's modification time is in the cache key).
        .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
        .body(body)
        .unwrap()
}

/// A parsed thumb://localhost/<id>?s=<pixels> request.
struct ThumbRequest {
    id: String,
    size: u32,
    path: PathBuf,
    modified: i64,
}

impl ThumbRequest {
    /// What a failure is remembered by.
    fn key(&self) -> String {
        format!("{}-{}-{}", self.id, self.size, self.modified)
    }
}

fn parse_request(library: &Library, uri: &str) -> Option<ThumbRequest> {
    let after = uri.split("://").nth(1).unwrap_or(uri);
    let rest = after.split_once('/').map(|(_, r)| r).unwrap_or("");
    let (id, query) = rest.split_once('?').unwrap_or((rest, ""));
    let asked: u32 = query.split('&').find_map(|kv| kv.strip_prefix("s=")).and_then(|s| s.parse().ok()).unwrap_or(512);
    // A few fixed sizes, so the cache stays small.
    let size = [256, 512, 1024, 2048].into_iter().find(|s| *s >= asked).unwrap_or(2048);
    if !valid_id(id) {
        return None;
    }
    let entry = library.photos.read().unwrap().get(id).cloned()?;
    if entry.pixels > MAX_PIXELS {
        return None;
    }
    let (path, modified) = (entry.path, entry.modified);
    Some(ThumbRequest { id: id.to_string(), size, path, modified })
}

fn cache_name(r: &ThumbRequest, ext: &str) -> String {
    format!("{}-{}-{}.{ext}", r.id, r.size, r.modified)
}

fn cached(cache: &Path, r: &ThumbRequest) -> Option<Response<Vec<u8>>> {
    [("jpg", "image/jpeg"), ("png", "image/png")]
        .into_iter()
        .find_map(|(ext, mime)| std::fs::read(cache.join(cache_name(r, ext))).ok().map(|bytes| respond(StatusCode::OK, mime, bytes)))
}

fn generate(cache: &Path, r: &ThumbRequest) -> Response<Vec<u8>> {
    // Only formats that can be see-through are kept as PNG.
    let may_be_clear = r.path.extension().and_then(|e| e.to_str()).is_some_and(|e| ["png", "apng", "gif", "webp", "heic", "heif", "avif", "tif", "tiff", "psd", "psb", "tga", "jxl", "jp2", "exr"].contains(&e.to_lowercase().as_str()));
    match thumbs::make(&r.path, r.size, may_be_clear) {
        Some(t) => {
            let ext = if t.mime == "image/png" { "png" } else { "jpg" };
            let _ = std::fs::create_dir_all(cache);
            let _ = std::fs::write(cache.join(cache_name(r, ext)), &t.bytes);
            respond(StatusCode::OK, t.mime, t.bytes)
        }
        None => respond(StatusCode::UNPROCESSABLE_ENTITY, "text/plain", b"can't read this picture".to_vec()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Pinboard's own pages: the bundled app, or the dev server while developing.
fn own_page(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" => cfg!(debug_assertions) && url.host_str() == Some("localhost") && url.port() == Some(1430),
        _ => false,
    }
}

pub fn run() {
    let library = Arc::new(Library::default());
    let workers = Arc::new(Semaphore::new(THUMB_WORKERS));
    let protocol_library = library.clone();
    tauri::Builder::default()
        // The window only ever shows Pinboard's own pages: any other address is refused.
        .plugin(tauri::plugin::Builder::<tauri::Wry, ()>::new("navigation-guard").on_navigation(|_, url| own_page(url)).build())
        .manage(library)
        .register_asynchronous_uri_scheme_protocol("thumb", move |ctx, request, responder| {
            let library = protocol_library.clone();
            let workers = workers.clone();
            let cache = ctx.app_handle().path().app_cache_dir().map(|d| d.join("thumbnails")).unwrap_or_else(|_| std::env::temp_dir().join("pinboard-thumbnails"));
            let uri = request.uri().to_string();
            tauri::async_runtime::spawn(async move {
                let Some(req) = parse_request(&library, &uri) else {
                    responder.respond(respond(StatusCode::NOT_FOUND, "text/plain", b"not in library".to_vec()));
                    return;
                };
                if library.failed.lock().unwrap().contains(&req.key()) {
                    responder.respond(respond(StatusCode::UNPROCESSABLE_ENTITY, "text/plain", b"can't read this picture".to_vec()));
                    return;
                }
                let req = Arc::new(req);
                let (c, r) = (cache.clone(), req.clone());
                // Already made: answer straight away, without waiting for a worker.
                if let Ok(Some(hit)) = tauri::async_runtime::spawn_blocking(move || cached(&c, &r)).await {
                    responder.respond(hit);
                    return;
                }
                let Ok(_permit) = workers.acquire_owned().await else { return };
                let key = req.key();
                let response = tauri::async_runtime::spawn_blocking(move || generate(&cache, &req)).await;
                let response = response.unwrap_or_else(|_| respond(StatusCode::INTERNAL_SERVER_ERROR, "text/plain", Vec::new()));
                if !response.status().is_success() {
                    library.failed.lock().unwrap().insert(key);
                }
                responder.respond(response);
            });
        })
        .invoke_handler(tauri::generate_handler![scan_library, reveal, open_photo, copy_photo, open_privacy_settings, cache_size, clear_cache, reveal_folder, reveal_photos, open_photos, copy_photos, trash, put_back])
        .run(tauri::generate_context!())
        .expect("error while running Pinboard");
}

#[cfg(test)]
mod harness {
    /// `cargo test --release harness -- --ignored`: the library and some thumbnails, for screenshots
    /// of the interface in a browser (see scripts/shot.mjs).
    #[test]
    #[ignore]
    fn dump_for_screenshots() {
        let home = std::path::PathBuf::from(std::env::var("HOME").unwrap());
        // It holds your own file names and thumbnails, so it goes in your private temporary folder.
        let out = std::env::var("PINBOARD_HARNESS").map(std::path::PathBuf::from).unwrap_or_else(|_| std::env::temp_dir().join("pinboard-harness"));
        std::fs::create_dir_all(out.join("thumbs")).unwrap();
        std::fs::set_permissions(&out, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
        let photos = crate::index::scan(&home);
        std::fs::write(out.join("library.json"), serde_json::to_vec(&photos).unwrap()).unwrap();
        for p in photos.iter().take(220) {
            if let Some(t) = crate::thumbs::make(std::path::Path::new(&p.path), 512, p.ext == "png") {
                std::fs::write(out.join("thumbs").join(&p.id), t.bytes).unwrap();
            }
        }
    }
}

#[cfg(test)]
mod trash_tests {
    use super::*;

    fn library_with(id: &str, path: &Path) -> Library {
        let library = Library::default();
        library.photos.write().unwrap().insert(id.into(), Entry { path: path.to_path_buf(), modified: 7, pixels: 100 });
        library
    }

    /// `cargo test trash_and_put_back -- --ignored`: a throwaway file in the home folder goes to the
    /// real Trash and comes back to the same place, by its id alone.
    #[test]
    #[ignore]
    fn trash_and_put_back() {
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        let dir = home.join("Library/Caches/app.pinboard.photos/trash-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("pinboard-trash-test.png");
        std::fs::write(&file, b"not really a png").unwrap();
        let library = library_with("00000000000000a1", &file);

        let result = trash_ids(&library, vec!["00000000000000a1".into(), "gone".into()]);
        assert_eq!(result.failed, vec!["gone".to_string()]);
        assert_eq!(result.trashed, vec!["00000000000000a1".to_string()]);
        let to = library.trashed.lock().unwrap().get("00000000000000a1").map(|t| t.to.clone()).unwrap();
        assert!(!file.exists() && to.is_file() && to.components().any(|c| c.as_os_str() == ".Trash"), "went to {to:?}");
        assert!(library.photos.read().unwrap().get("00000000000000a1").is_none());

        // Ids Pinboard didn't move do nothing.
        assert!(put_back_ids(&library, vec!["ffffffffffffffff".into()]).is_empty());

        assert_eq!(put_back_ids(&library, vec!["00000000000000a1".into()]), vec!["00000000000000a1".to_string()]);
        assert!(file.is_file() && !to.exists());
        assert_eq!(library.photos.read().unwrap().get("00000000000000a1").map(|e| (e.path.clone(), e.modified)), Some((file.clone(), 7)));
        // Once back, the record is gone: a second Undo moves nothing.
        assert!(put_back_ids(&library, vec!["00000000000000a1".into()]).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg(test)]
mod guard_tests {
    use super::*;

    #[test]
    fn only_hex_ids_reach_the_cache() {
        assert!(valid_id("0123456789abcdef"));
        for bad in ["", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "/etc/passwd00000", "../../../../x.jp", "0123456789abcde/"] {
            assert!(!valid_id(bad), "{bad}");
        }
        let library = library_with_photo("0123456789abcdef", "/tmp/a.jpg", 100);
        assert!(parse_request(&library, "thumb://localhost/0123456789abcdef?s=512").is_some());
        assert!(parse_request(&library, "thumb://localhost//etc/passwd?s=512").is_none());
        assert!(parse_request(&library, "thumb://localhost/..%2F..%2Fx?s=512").is_none());
    }

    #[test]
    fn huge_pictures_get_no_thumbnail() {
        let library = library_with_photo("0123456789abcdef", "/tmp/a.png", MAX_PIXELS + 1);
        assert!(parse_request(&library, "thumb://localhost/0123456789abcdef?s=256").is_none());
    }

    #[test]
    fn only_library_folders_are_shown() {
        let home = std::env::temp_dir().join(format!("pinboard-folders-{}", std::process::id()));
        std::fs::create_dir_all(home.join("Downloads/Trip")).unwrap();
        std::fs::create_dir_all(home.join("Downloads/Evil.app/Contents")).unwrap();
        let library = library_with_photo("0123456789abcdef", &home.join("Downloads/Trip/a.jpg").to_string_lossy(), 100);
        assert!(library_folder(&library, "Downloads/Trip", &home).is_ok());
        assert!(library_folder(&library, "Downloads", &home).is_ok());
        assert!(library_folder(&library, "Downloads/Evil.app", &home).is_err(), "holds no pictures");
        for bad in ["", "/", "..", "Downloads/../..", "Downloads//Trip", "./Downloads"] {
            assert!(library_folder(&library, bad, &home).is_err(), "{bad}");
        }
        // A link inside the home folder that leads out of it is refused.
        std::os::unix::fs::symlink(std::env::temp_dir(), home.join("Downloads/Trip/out")).unwrap();
        library.photos.write().unwrap().insert("0123456789abcde0".into(), Entry { path: home.join("Downloads/Trip/out/b.jpg"), modified: 0, pixels: 1 });
        assert!(library_folder(&library, "Downloads/Trip/out", &home).is_err());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn the_window_stays_on_pinboard() {
        assert!(own_page(&"tauri://localhost/".parse().unwrap()));
        assert!(!own_page(&"https://example.com/?leak".parse().unwrap()));
        assert!(!own_page(&"file:///etc/passwd".parse().unwrap()));
        assert!(!own_page(&"tauri://evil/".parse().unwrap()));
    }

    fn library_with_photo(id: &str, path: &str, pixels: u64) -> Library {
        let library = Library::default();
        library.photos.write().unwrap().insert(id.into(), Entry { path: PathBuf::from(path), modified: 0, pixels });
        library
    }
}
