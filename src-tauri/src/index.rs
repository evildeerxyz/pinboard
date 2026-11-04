//! Finds every picture in the home folder with one Spotlight query.
//!
//! Spotlight already knows each image's size, whether it is a screenshot, the camera that took it
//! and when, so nothing is crawled and no file is opened: about two seconds for the whole home
//! folder. Pictures that belong to apps rather than to you (icons, build output, app bundles,
//! caches, libraries) are left out.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    /// Stable id: a hash of the path.
    pub id: String,
    pub path: String,
    pub name: String,
    /// The folder it's in, relative to the home folder ("Downloads/Trip").
    pub folder: String,
    pub width: u32,
    pub height: u32,
    pub screenshot: bool,
    /// The camera or phone that took it, when the file says.
    pub camera: Option<String>,
    /// When it was taken (or made), in milliseconds since 1970.
    pub taken: i64,
    pub modified: i64,
    pub bytes: u64,
    /// Lowercase extension, like "jpg".
    pub ext: String,
}

const ATTRS: [&str; 5] = [
    "kMDItemPixelWidth",
    "kMDItemPixelHeight",
    "kMDItemIsScreenCapture",
    "kMDItemAcquisitionModel",
    "kMDItemContentCreationDate",
];

/// Folder names whose pictures belong to software, not to you.
const SKIP_DIRS: &[&str] = &[
    "Library", "node_modules", "bower_components", "DerivedData", "Pods", "Carthage", "build", "dist", "target",
    "out", "vendor", "venv", "site-packages", "__pycache__", "Caches", "cache", "tmp", "temp", "gen", "generated",
    "res", "assets.xcassets", "Applications", "User Data",
];

/// Bundles and packages: a picture inside one is part of it.
const SKIP_DIR_SUFFIXES: &[&str] = &[
    ".app", ".xcassets", ".imageset", ".appiconset", ".bundle", ".framework", ".photoslibrary", ".imovielibrary",
    ".fcpbundle", ".xcarchive", ".playground", ".lproj", ".iconset", ".pkg", ".plugin", ".kext", ".tvlibrary",
];

/// The only files listed: pictures, by extension. Anything else (an app, a script, a document) is
/// never in the library, whatever Spotlight says it is, so nothing in Pinboard can open or run it.
/// Icons, cursors and vector art aren't here either: they aren't photos.
const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "jpe", "jfif", "png", "apng", "gif", "webp", "heic", "heif", "hif", "avif", "jxl", "tif", "tiff", "bmp",
    "jp2", "j2k", "psd", "psb", "tga", "exr", "hdr", "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "raf",
    "orf", "rw2", "pef", "srw", "raw", "rwl", "3fr", "erf", "kdc", "mrw", "x3f", "iiq",
];

/// Whether a picture's file name ends in an extension Pinboard lists.
pub fn is_image(path: &str) -> bool {
    Path::new(path).extension().and_then(|e| e.to_str()).is_some_and(|e| IMAGE_EXTS.contains(&e.to_lowercase().as_str()))
}

/// Top-level folders of the home folder where code lives: nothing in them is listed.
const CODE_HOMES: &[&str] = &[
    "Developer", "Projects", "projects", "Code", "code", "src", "repos", "Repos", "workspace", "Workspace", "dev",
    "git", "GitHub", "Github", "Sites", "go", "AndroidStudioProjects", "PycharmProjects", "IdeaProjects",
    "WebstormProjects", "XcodeProjects", "eclipse-workspace", "Unity",
];

/// A folder holding any of these is a code project: none of its pictures are listed, wherever it is.
const PROJECT_MARKERS: &[&str] = &[
    ".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", "setup.py", "requirements.txt", "Package.swift",
    "Podfile", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "pubspec.yaml",
    "CMakeLists.txt", "project.yml", "deno.json", "tsconfig.json",
];

/// What a scan leaves out (Settings › Library).
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOptions {
    /// Code projects (Developer, any folder with package.json, .git…).
    pub skip_code: bool,
    /// Icons, sprites and other pictures too small to look at.
    pub skip_small: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self { skip_code: true, skip_small: true }
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn scan(home: &Path) -> Vec<Photo> {
    scan_with(home, ScanOptions::default())
}

pub fn scan_with(home: &Path, options: ScanOptions) -> Vec<Photo> {
    let mut args: Vec<String> = vec!["-0".into(), "-onlyin".into(), home.display().to_string()];
    for a in ATTRS {
        args.push("-attr".into());
        args.push(a.into());
    }
    args.push(r#"kMDItemContentTypeTree == "public.image""#.into());
    let Ok(out) = Command::new("/usr/bin/mdfind").args(&args).output() else { return Vec::new() };
    let home_str = home.display().to_string();
    let mut code = CodeFolders { home: home.to_path_buf(), known: HashMap::new() };
    let mut photos: Vec<Photo> = out
        .stdout
        .split(|b| *b == 0)
        .filter_map(|record| parse(&String::from_utf8_lossy(record), &home_str, options.skip_small))
        .filter(|p| !options.skip_code || !code.contains(&p.folder))
        .collect();
    photos.sort_by(|a, b| b.taken.cmp(&a.taken));
    photos
}

/// Whether a folder (relative to home) is, or is inside, a code project. Each folder is looked at once.
struct CodeFolders {
    home: PathBuf,
    known: HashMap<String, bool>,
}

impl CodeFolders {
    fn contains(&mut self, rel: &str) -> bool {
        if rel.is_empty() {
            return false;
        }
        if let Some(&known) = self.known.get(rel) {
            return known;
        }
        let top = rel.split('/').next().unwrap_or("");
        let name = rel.rsplit('/').next().unwrap_or("");
        let parent = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        let is_code = (parent.is_empty() && CODE_HOMES.contains(&top))
            || name.ends_with(".xcodeproj")
            || name.ends_with(".xcworkspace")
            || self.contains(parent)
            || PROJECT_MARKERS.iter().any(|m| self.home.join(rel).join(m).exists());
        self.known.insert(rel.to_string(), is_code);
        is_code
    }
}

fn parse(record: &str, home: &str, skip_small: bool) -> Option<Photo> {
    // "<path>   kMDItemPixelWidth = 3600   kMDItemPixelHeight = 2270   …". A file name can contain
    // that text itself, so try each place it appears and take the first that leaves the path of a
    // real picture file: a crafted name can't make Pinboard list some other file.
    let marker = format!("   {} = ", ATTRS[0]);
    let (path, attrs) = record.match_indices(&marker).find_map(|(at, _)| {
        let path = record[..at].trim_end_matches('\n');
        (is_image(path) && Path::new(path).is_file()).then(|| (path, &record[at..]))
    })?;
    let rel = path.strip_prefix(home)?.trim_start_matches('/');
    if rel.is_empty() || skipped(rel) {
        return None;
    }
    let ext = Path::new(path).extension()?.to_str()?.to_lowercase();
    // Values come from the picture itself (a camera name is whatever its file says), so each is
    // read after the path, and the date, the last one, from its last marker.
    let value = |attr: &str| -> Option<&str> {
        let marker = format!("   {attr} = ");
        let start = if attr == ATTRS[4] { attrs.rfind(&marker)? } else { attrs.find(&marker)? } + marker.len();
        let rest = &attrs[start..];
        let end = rest.find("   kMDItem").unwrap_or(rest.len());
        let v = rest[..end].trim();
        (v != "(null)").then_some(v)
    };
    let width: u32 = value(ATTRS[0]).and_then(|v| v.parse().ok()).unwrap_or(0);
    let height: u32 = value(ATTRS[1]).and_then(|v| v.parse().ok()).unwrap_or(0);
    let screenshot = value(ATTRS[2]) == Some("1");
    let camera = value(ATTRS[3]).map(|v| v.trim_matches('"').trim().to_string()).filter(|v| !v.is_empty());

    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let bytes = meta.len();
    // Icons, sprites and UI bits: too small to be a picture you'd look at.
    let (short, long) = (width.min(height), width.max(height));
    let big_enough = if !skip_small {
        width == 0 || short >= 64
    } else if width == 0 || height == 0 {
        bytes >= 40_000
    } else if screenshot {
        short >= 160 && long >= 320
    } else {
        short >= 240 && long >= 320
    };
    if !big_enough {
        return None;
    }
    let ms = |t: std::io::Result<std::time::SystemTime>| t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64);
    let modified = ms(meta.modified()).unwrap_or(0);
    let taken = value(ATTRS[4]).and_then(parse_date).or_else(|| ms(meta.created())).unwrap_or(modified);

    let name = Path::new(path).file_name()?.to_string_lossy().to_string();
    let folder = Path::new(rel).parent().map(|p| p.display().to_string()).unwrap_or_default();
    Some(Photo { id: id_for(path), path: path.to_string(), name, folder, width, height, screenshot, camera, taken, modified, bytes, ext })
}

fn skipped(rel: &str) -> bool {
    let mut parts = rel.split('/').peekable();
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            return part.starts_with('.');
        }
        if part.starts_with('.') || SKIP_DIRS.contains(&part) || SKIP_DIR_SUFFIXES.iter().any(|s| part.ends_with(s)) {
            return true;
        }
        // Android drawables and launcher icons.
        if part.starts_with("mipmap-") || part.starts_with("drawable-") {
            return true;
        }
    }
    false
}

/// FNV-1a, so an id stays the same from one launch to the next.
pub fn id_for(path: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// "2026-11-04 09:30:23 +0000" to milliseconds since 1970. Anything outside real calendar ranges
/// (a date can come from the picture's own metadata) is refused, so the sums below can't overflow.
fn parse_date(s: &str) -> Option<i64> {
    let (date, rest) = s.split_once(' ')?;
    let time = rest.split(' ').next()?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let mut t = time.split(':').map(|p| p.parse::<i64>().ok());
    let (hh, mm, ss) = (t.next()??, t.next()??, t.next()??);
    if !(1800..=2300).contains(&y) || !(1..=12).contains(&m) || !(1..=31).contains(&day) || !(0..=23).contains(&hh) || !(0..=59).contains(&mm) || !(0..=60).contains(&ss) {
        return None;
    }
    // Days from 1970-01-01 (Howard Hinnant's days_from_civil).
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400) + hh * 3600 + mm * 60 + ss) * 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_spotlight_dates() {
        assert_eq!(parse_date("1970-01-01 00:00:00 +0000"), Some(0));
        assert_eq!(parse_date("2026-11-04 09:30:23 +0000"), Some(1_793_784_623_000));
    }

    #[test]
    fn skips_software_folders() {
        assert!(skipped("Developer/app/node_modules/x/a.png"));
        assert!(skipped("Applications/Foo.app/Contents/Resources/a.png"));
        assert!(skipped("Developer/app/ios/App/Images.xcassets/AppIcon.appiconset/a.png"));
        assert!(skipped("Library/Caches/a.jpg"));
        assert!(skipped("Downloads/.hidden/a.jpg"));
        assert!(!skipped("Downloads/Trip/Post 1/1.jpg"));
        assert!(!skipped("Pictures/a.jpg"));
    }

    #[test]
    fn leaves_out_code_projects() {
        let home = std::env::temp_dir().join(format!("pinboard-code-{}", std::process::id()));
        std::fs::create_dir_all(home.join("Downloads/repo/assets")).unwrap();
        std::fs::create_dir_all(home.join("Downloads/Trip")).unwrap();
        std::fs::write(home.join("Downloads/repo/package.json"), "{}").unwrap();
        let mut code = CodeFolders { home: home.clone(), known: HashMap::new() };
        assert!(code.contains("Developer/anything"));
        assert!(code.contains("Downloads/repo/assets"));
        assert!(!code.contains("Downloads/Trip"));
        assert!(!code.contains("Downloads"));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn parses_a_record() {
        let home = std::env::var("HOME").unwrap();
        let path = format!("{home}/Downloads/pinboard-test-does-not-exist.jpg");
        let rec = format!("{path}   kMDItemPixelWidth = 3600   kMDItemPixelHeight = 2270   kMDItemIsScreenCapture = 1   kMDItemAcquisitionModel = (null)   kMDItemContentCreationDate = 2026-11-04 09:30:23 +0000");
        // The file doesn't exist, so it's dropped: only real files are listed.
        assert!(parse(&rec, &home, true).is_none());
    }

    /// A file named to look like Spotlight's own output can't make the scan list a different file.
    #[test]
    fn a_crafted_name_lists_only_the_real_picture() {
        let home = std::env::temp_dir().join(format!("pinboard-names-{}", std::process::id()));
        let dir = home.join("Downloads");
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("Trip.command");
        let picture = dir.join("Trip.command   kMDItemPixelWidth = 4000   kMDItemPixelHeight = 3000.jpg");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        std::fs::write(&picture, vec![0u8; 50_000]).unwrap();
        let home_str = home.to_string_lossy().to_string();
        let rec = format!("{}   kMDItemPixelWidth = 1200   kMDItemPixelHeight = 900   kMDItemIsScreenCapture = (null)   kMDItemAcquisitionModel = \"x   kMDItemContentCreationDate = 1999-01-01 00:00:00 +0000\"   kMDItemContentCreationDate = 2026-11-04 09:30:23 +0000", picture.display());
        let photo = parse(&rec, &home_str, true).expect("the real picture is listed");
        assert_eq!(photo.path, picture.to_string_lossy());
        assert_eq!((photo.width, photo.height), (1200, 900));
        assert_eq!(photo.taken, parse_date("2026-11-04 09:30:23 +0000").unwrap(), "the date comes from Spotlight, not the camera name");
        // And a non-picture is never listed, even when Spotlight reports it.
        let rec = format!("{}   kMDItemPixelWidth = 1200   kMDItemPixelHeight = 900", script.display());
        assert!(parse(&rec, &home_str, true).is_none());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn refuses_impossible_dates() {
        assert!(parse_date("999999999999999-01-01 00:00:00 +0000").is_none());
        assert!(parse_date("2026-13-01 00:00:00 +0000").is_none());
        assert!(parse_date("2026-01-01 25:00:00 +0000").is_none());
        assert!(parse_date("2026-11-04 09:30:23 +0000").is_some());
    }
}


#[cfg(test)]
mod survey {
    /// `cargo test --release survey -- --ignored --nocapture`: what a scan of the home folder finds.
    #[test]
    #[ignore]
    fn survey_home() {
        let home = std::path::PathBuf::from(std::env::var("HOME").unwrap());
        let start = std::time::Instant::now();
        let photos = super::scan(&home);
        println!("{} pictures in {:?}", photos.len(), start.elapsed());
        let mut by: std::collections::HashMap<String, usize> = Default::default();
        for p in &photos { let k: Vec<&str> = p.folder.split('/').take(3).collect(); *by.entry(k.join("/")).or_default() += 1; }
        let mut v: Vec<_> = by.into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1));
        for (k, n) in v.iter().take(12) { println!("{n:6} {k}"); }
    }
}
