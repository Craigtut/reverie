// Read an image off the macOS general pasteboard as PNG bytes.
//
// Backs clipboard-image paste: when the user copies a screenshot or an image
// and pastes into a terminal session, Reverie reads the pasteboard here,
// normalizes whatever the source put there (PNG, TIFF, or a bare NSImage) to
// PNG, and hands the bytes to Rust, which writes a temp file the CLI can attach
// by path. Exposed as a tiny C ABI the Rust `clipboard` module wraps. Mirrors
// the bookmark shim's malloc/free ownership contract.

#import <AppKit/AppKit.h>
#include <dispatch/dispatch.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// Copy an NSData's bytes into a malloc'd buffer the caller frees via
// `reverie_clipboard_free`. Returns false (leaving out-params untouched) if the
// data is nil/empty or allocation fails.
static bool copy_out(NSData *data, uint8_t **out, size_t *out_len) {
  if (data == nil || data.length == 0) {
    return false;
  }
  size_t len = (size_t)data.length;
  uint8_t *buf = (uint8_t *)malloc(len);
  if (buf == NULL) {
    return false;
  }
  memcpy(buf, data.bytes, len);
  *out = buf;
  *out_len = len;
  return true;
}

// Re-encode arbitrary bitmap data (TIFF, etc.) as PNG. Returns nil on failure.
static NSData *png_from_bitmap_data(NSData *bitmap) {
  if (bitmap == nil) {
    return nil;
  }
  NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithData:bitmap];
  if (rep == nil) {
    return nil;
  }
  return [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}

// The actual pasteboard read. Must run on the main thread: NSBitmapImageRep,
// NSImage, and `readObjectsForClasses:` are not thread-safe. On success
// allocates `*out` (malloc) with the PNG bytes and sets `*out_len`.
static bool read_png_impl(uint8_t **out, size_t *out_len) {
  @autoreleasepool {
    NSPasteboard *pb = [NSPasteboard generalPasteboard];

    // Prefer a PNG the source already provided (lossless, no re-encode).
    NSData *png = [pb dataForType:NSPasteboardTypePNG];
    if (png != nil && png.length > 0) {
      return copy_out(png, out, out_len);
    }

    // Screenshots and many apps put TIFF on the pasteboard; re-encode to PNG.
    NSData *tiff = [pb dataForType:NSPasteboardTypeTIFF];
    NSData *fromTiff = png_from_bitmap_data(tiff);
    if (fromTiff != nil) {
      return copy_out(fromTiff, out, out_len);
    }

    // Last resort: ask for an NSImage object (covers file-promise / image-only
    // sources) and render it to PNG via its TIFF representation.
    NSArray *images = [pb readObjectsForClasses:@[ [NSImage class] ] options:nil];
    if (images.count > 0) {
      NSImage *image = images.firstObject;
      NSData *fromImage = png_from_bitmap_data(image.TIFFRepresentation);
      if (fromImage != nil) {
        return copy_out(fromImage, out, out_len);
      }
    }

    return false;
  }
}

// Read the general pasteboard's image as PNG. On success allocates `*out`
// (malloc) with the PNG bytes, sets `*out_len`, and returns true; the caller
// frees `*out` via `reverie_clipboard_free`. Returns false when the pasteboard
// holds no image we can turn into a PNG. Marshals the AppKit work onto the main
// thread, since Tauri invokes commands off the main thread.
bool reverie_clipboard_read_png(uint8_t **out, size_t *out_len) {
  if (out == NULL || out_len == NULL) {
    return false;
  }
  if ([NSThread isMainThread]) {
    return read_png_impl(out, out_len);
  }
  __block bool ok = false;
  dispatch_sync(dispatch_get_main_queue(), ^{
    ok = read_png_impl(out, out_len);
  });
  return ok;
}

void reverie_clipboard_free(uint8_t *ptr) { free(ptr); }
