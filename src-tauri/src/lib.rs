mod index;
mod thumbs;

use index::Photo;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{NSPasteboard, NSPasteboardWriting, NSWorkspace};
use objc2_foundation::{NSArray, NSFileManager, NSString, NSURL};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, RwLock};
use tauri::http::{header, Response, StatusCode};
use tauri::{Manager, State};
use tokio::sync::Semaphore;

/// What the window may look at: the indexed pictures, by id. Thumbnails and Finder actions only
/// ever reach files in here, never an arbitrary path.
#[derive(Default)]
struct Library {
    photos: RwLock<HashMap<String, (PathBuf, i64)>>,
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
    let map = scan.photos.iter().map(|p| (p.id.clone(), (PathBuf::from(&p.path), p.modified))).collect();
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

/// Shows a folder of the home folder (by its path inside it) in Finder.
#[tauri::command]
fn reveal_folder(folder: String) -> Result<(), String> {
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("No home folder")?;
    if folder.split('/').any(|part| part == ".." || part.is_empty()) {
        return Err("That isn't a folder in your home folder.".into());
    }
    let path = home.join(&folder);
    if !path.is_dir() {
        return Err("That folder isn't there any more.".into());
    }
    Command::new("/usr/bin/open").arg(path).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// System Settings › Privacy & Security › Files and Folders.
#[tauri::command]
fn open_privacy_settings() -> Result<(), String> {
    Command::new("/usr/bin/open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders").status().map_err(|e| e.to_string())?;
    Ok(())
}

fn indexed_path(library: &Library, id: &str) -> Result<PathBuf, String> {
    library.photos.read().unwrap().get(id).map(|(p, _)| p.clone()).ok_or_else(|| "That picture isn't in the library any more.".into())
}

/// The indexed pictures among these ids (any that have gone are left out).
fn indexed_paths(library: &Library, ids: &[String]) -> Result<Vec<PathBuf>, String> {
    let photos = library.photos.read().unwrap();
    let paths: Vec<PathBuf> = ids.iter().filter_map(|id| photos.get(id).map(|(p, _)| p.clone())).collect();
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
    let paths = indexed_paths(&library, &ids)?;
    Command::new("/usr/bin/open").args(&paths).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// A picture moved to the Trash: where it was, and where it went, so it can be put back.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Trashed {
    id: String,
    from: String,
    to: String,
    modified: i64,
}

#[derive(serde::Serialize)]
struct TrashResult {
    trashed: Vec<Trashed>,
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
        let Some((path, modified)) = library.photos.read().unwrap().get(&id).cloned() else {
            result.failed.push(id);
            continue;
        };
        let mut went: Option<Retained<NSURL>> = None;
        match files.trashItemAtURL_resultingItemURL_error(&file_url(&path), Some(&mut went)) {
            Ok(()) => {
                library.photos.write().unwrap().remove(&id);
                let to = went.and_then(|u| u.path()).map(|p| p.to_string()).unwrap_or_default();
                result.trashed.push(Trashed { id, from: path.to_string_lossy().into_owned(), to, modified });
            }
            Err(_) => result.failed.push(id),
        }
    }
    result
}

/// Undo for `trash`: moves pictures back out of the Trash to where they were. Only ever from a
/// Trash folder, only into a folder of the home folder that's still there, and never over a file.
#[tauri::command]
fn put_back(items: Vec<Trashed>, library: State<'_, Arc<Library>>) -> Result<Vec<String>, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("No home folder")?;
    Ok(put_back_items(&library, items, &home))
}

/// The ids of the pictures that went back.
fn put_back_items(library: &Library, items: Vec<Trashed>, home: &Path) -> Vec<String> {
    let mut back = Vec::new();
    for item in items {
        let (from, to) = (PathBuf::from(&item.from), PathBuf::from(&item.to));
        let from_trash = to.components().any(|c| c.as_os_str() == ".Trash" || c.as_os_str() == ".Trashes");
        let home_again = from.starts_with(home) && from.parent().is_some_and(|p| p.is_dir()) && !from.exists();
        if from_trash && to.is_file() && home_again && std::fs::rename(&to, &from).is_ok() {
            library.photos.write().unwrap().insert(item.id.clone(), (from, item.modified));
            back.push(item.id);
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
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
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

fn parse_request(library: &Library, uri: &str) -> Option<ThumbRequest> {
    let after = uri.split("://").nth(1).unwrap_or(uri);
    let rest = after.split_once('/').map(|(_, r)| r).unwrap_or("");
    let (id, query) = rest.split_once('?').unwrap_or((rest, ""));
    let asked: u32 = query.split('&').find_map(|kv| kv.strip_prefix("s=")).and_then(|s| s.parse().ok()).unwrap_or(512);
    // A few fixed sizes, so the cache stays small.
    let size = [256, 512, 1024, 2048].into_iter().find(|s| *s >= asked).unwrap_or(2048);
    let (path, modified) = library.photos.read().unwrap().get(id).cloned()?;
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
    match thumbs::make(&r.path, r.size) {
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
pub fn run() {
    let library = Arc::new(Library::default());
    let workers = Arc::new(Semaphore::new(THUMB_WORKERS));
    let protocol_library = library.clone();
    tauri::Builder::default()
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
                let req = Arc::new(req);
                let (c, r) = (cache.clone(), req.clone());
                // Already made: answer straight away, without waiting for a worker.
                if let Ok(Some(hit)) = tauri::async_runtime::spawn_blocking(move || cached(&c, &r)).await {
                    responder.respond(hit);
                    return;
                }
                let Ok(_permit) = workers.acquire_owned().await else { return };
                let response = tauri::async_runtime::spawn_blocking(move || generate(&cache, &req)).await;
                responder.respond(response.unwrap_or_else(|_| respond(StatusCode::INTERNAL_SERVER_ERROR, "text/plain", Vec::new())));
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
        let out = std::path::PathBuf::from(std::env::var("PINBOARD_HARNESS").unwrap_or("/tmp/pinboard-harness".into()));
        std::fs::create_dir_all(out.join("thumbs")).unwrap();
        let photos = crate::index::scan(&home);
        std::fs::write(out.join("library.json"), serde_json::to_vec(&photos).unwrap()).unwrap();
        for p in photos.iter().take(220) {
            if let Some(t) = crate::thumbs::make(std::path::Path::new(&p.path), 512) {
                std::fs::write(out.join("thumbs").join(&p.id), t.bytes).unwrap();
            }
        }
    }
}

#[cfg(test)]
mod trash_tests {
    use super::*;

    /// `cargo test trash_and_put_back -- --ignored`: a throwaway file in the home folder goes to the
    /// real Trash and comes back to the same place.
    #[test]
    #[ignore]
    fn trash_and_put_back() {
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        let dir = home.join("Library/Caches/app.pinboard.photos/trash-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("pinboard-trash-test.png");
        std::fs::write(&file, b"not really a png").unwrap();
        let library = Library::default();
        library.photos.write().unwrap().insert("t1".into(), (file.clone(), 7));

        let result = trash_ids(&library, vec!["t1".into(), "gone".into()]);
        assert_eq!(result.failed, vec!["gone".to_string()]);
        assert_eq!(result.trashed.len(), 1);
        let to = PathBuf::from(&result.trashed[0].to);
        assert!(!file.exists() && to.is_file() && to.components().any(|c| c.as_os_str() == ".Trash"), "went to {to:?}");
        assert!(library.photos.read().unwrap().get("t1").is_none());

        // Never back over a file that's there now, nor out of a folder that isn't a Trash.
        let bogus = Trashed { id: "x".into(), from: file.to_string_lossy().into(), to: dir.join("nope.png").to_string_lossy().into(), modified: 0 };
        assert!(put_back_items(&library, vec![bogus], &home).is_empty());

        assert_eq!(put_back_items(&library, result.trashed, &home), vec!["t1".to_string()]);
        assert!(file.is_file() && !to.exists());
        assert_eq!(library.photos.read().unwrap().get("t1").map(|(p, m)| (p.clone(), *m)), Some((file.clone(), 7)));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
