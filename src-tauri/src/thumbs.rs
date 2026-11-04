//! Thumbnails with macOS's ImageIO: the same decoder Finder and Preview use, so HEIC, RAW, PSD,
//! WebP and the rest all work, the photo's own orientation is applied, and a camera file's
//! embedded preview is used when it's big enough (no full decode). Made only when a picture
//! scrolls into view, then kept on disk.

use objc2_core_foundation::{CFBoolean, CFDictionary, CFMutableData, CFNumber, CFString, CFType, CFURL};
use objc2_core_graphics::{CGImage, CGImageAlphaInfo};
use objc2_image_io::{
    kCGImageDestinationLossyCompressionQuality, kCGImageSourceCreateThumbnailFromImageAlways,
    kCGImageSourceCreateThumbnailWithTransform, kCGImageSourceShouldCache, kCGImageSourceThumbnailMaxPixelSize,
    CGImageDestination, CGImageSource,
};
use std::path::Path;

pub struct Thumbnail {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

/// A picture no larger than `max` pixels on its long side.
pub fn make(path: &Path, max: u32) -> Option<Thumbnail> {
    let url = CFURL::from_file_path(path)?;
    // Don't keep the decoded original around: only the small copy is wanted.
    let source_opts = unsafe { CFDictionary::<CFString, CFType>::from_slices(&[kCGImageSourceShouldCache], &[CFBoolean::new(false).as_ref()]) };
    let source = unsafe { CGImageSource::with_url(&url, Some(source_opts.as_ref())) }?;
    let size = CFNumber::new_i32(max as i32);
    let keys = unsafe { [kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceCreateThumbnailWithTransform, kCGImageSourceThumbnailMaxPixelSize] };
    let values: [&CFType; 3] = [CFBoolean::new(true).as_ref(), CFBoolean::new(true).as_ref(), size.as_ref()];
    let options = CFDictionary::<CFString, CFType>::from_slices(&keys, &values);
    let image = unsafe { source.thumbnail_at_index(0, Some(options.as_ref())) }?;
    encode(&image)
}

/// JPEG, or PNG when the picture has transparency (a JPEG would turn it black).
fn encode(image: &CGImage) -> Option<Thumbnail> {
    let alpha = CGImage::alpha_info(Some(image));
    let opaque = matches!(alpha, CGImageAlphaInfo::None | CGImageAlphaInfo::NoneSkipFirst | CGImageAlphaInfo::NoneSkipLast);
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
        let thumb = make(Path::new(&photo.path), 512).expect("thumbnail");
        assert_eq!(thumb.mime, "image/jpeg");
        assert!(thumb.bytes.len() > 1000 && thumb.bytes.starts_with(&[0xFF, 0xD8]));
    }
}
