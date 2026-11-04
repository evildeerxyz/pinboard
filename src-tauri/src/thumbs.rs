//! Thumbnails made by Quick Look, the way Finder makes them. The picture is decoded by macOS's own
//! thumbnail service, in a separate sandboxed process, never inside Pinboard: a malformed or
//! malicious image (a downloaded file can be anything) can't run code with Pinboard's access to
//! your folders, and one that is huge or broken can't crash Pinboard or eat its memory. HEIC, RAW,
//! PSD, WebP and the rest all work, with the photo's own orientation applied.
//!
//! Pinboard only ever touches the finished small image, to encode it as JPEG or PNG with ImageIO.

use block2::RcBlock;
use objc2::AllocAnyThread;
use objc2_core_foundation::{CFDictionary, CFMutableData, CFNumber, CFString, CFType, CGFloat, CGSize};
use objc2_core_graphics::{CGImage, CGImageAlphaInfo};
use objc2_foundation::{NSError, NSString, NSURL};
use objc2_image_io::{kCGImageDestinationLossyCompressionQuality, CGImageDestination};
use objc2_quick_look_thumbnailing::{QLThumbnailGenerationRequest, QLThumbnailGenerationRequestRepresentationTypes, QLThumbnailGenerator, QLThumbnailRepresentation};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

pub struct Thumbnail {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

/// How long to wait for Quick Look before giving up on a picture.
const WAIT: Duration = Duration::from_secs(20);

/// A picture no larger than `max` pixels on its long side. `may_be_clear` says whether the file's
/// format can have transparency (PNG, GIF, WebP…): only then is it kept as PNG.
pub fn make(path: &Path, max: u32, may_be_clear: bool) -> Option<Thumbnail> {
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    let size = CGSize { width: max as CGFloat, height: max as CGFloat };
    let generator = unsafe { QLThumbnailGenerator::sharedGenerator() };
    // Only a real thumbnail of the picture: no file icon in its place.
    let request = unsafe {
        QLThumbnailGenerationRequest::initWithFileAtURL_size_scale_representationTypes(
            QLThumbnailGenerationRequest::alloc(),
            &url,
            size,
            1.0,
            QLThumbnailGenerationRequestRepresentationTypes::Thumbnail,
        )
    };
    let (done, result) = mpsc::sync_channel::<Option<Thumbnail>>(1);
    // Quick Look answers on a queue of its own; the small image is encoded there and handed back.
    let handler = RcBlock::new(move |representation: *mut QLThumbnailRepresentation, _error: *mut NSError| {
        let thumbnail = unsafe { representation.as_ref() }.and_then(|r| encode(&*unsafe { r.CGImage() }, may_be_clear));
        let _ = done.try_send(thumbnail);
    });
    unsafe { generator.generateBestRepresentationForRequest_completionHandler(&request, &handler) };
    match result.recv_timeout(WAIT) {
        Ok(thumbnail) => thumbnail,
        Err(_) => {
            unsafe { generator.cancelRequest(&request) };
            None
        }
    }
}

/// JPEG, or PNG when the picture really has transparency (a JPEG would turn it black).
fn encode(image: &CGImage, may_be_clear: bool) -> Option<Thumbnail> {
    let alpha = CGImage::alpha_info(Some(image));
    let opaque = !may_be_clear || matches!(alpha, CGImageAlphaInfo::None | CGImageAlphaInfo::NoneSkipFirst | CGImageAlphaInfo::NoneSkipLast);
    let (uti, mime) = if opaque { ("public.jpeg", "image/jpeg") } else { ("public.png", "image/png") };
    let data = CFMutableData::new(None, 0)?;
    let kind = CFString::from_static_str(uti);
    let dest = unsafe { CGImageDestination::with_data(&data, &kind, 1, None) }?;
    let quality = CFNumber::new_f64(0.8);
    let props = unsafe { CFDictionary::<CFString, CFType>::from_slices(&[kCGImageDestinationLossyCompressionQuality], &[quality.as_ref()]) };
    unsafe {
        dest.add_image(image, Some(props.as_ref()));
        if !dest.finalize() {
            return None;
        }
    }
    Some(Thumbnail { bytes: data.to_vec(), mime })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Makes a thumbnail of a real picture (the first JPEG in Downloads), if there is one.
    #[test]
    fn makes_a_jpeg_thumbnail() {
        let home = std::env::var("HOME").unwrap();
        let photos = crate::index::scan(Path::new(&format!("{home}/Downloads")));
        let Some(photo) = photos.iter().find(|p| p.ext == "jpg" || p.ext == "jpeg") else { return };
        let thumb = make(Path::new(&photo.path), 512, false).expect("thumbnail");
        assert_eq!(thumb.mime, "image/jpeg");
        assert!(thumb.bytes.len() > 1000 && thumb.bytes.starts_with(&[0xFF, 0xD8]));
    }

    /// A file that only pretends to be a picture gets no thumbnail (and no file icon instead).
    #[test]
    fn refuses_a_fake_picture() {
        let path = std::env::temp_dir().join(format!("pinboard-fake-{}.jpg", std::process::id()));
        std::fs::write(&path, b"#!/bin/sh\necho not a picture\n").unwrap();
        assert!(make(&path, 512, false).is_none());
        let _ = std::fs::remove_file(path);
    }
}
