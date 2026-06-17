// Folder-identity bookmarks over Foundation's NSURL bookmark APIs.
//
// A bookmark encodes a folder's stable identity (volume UUID + catalog node id),
// so the OS can relocate it after a rename or a move within the same volume. We
// use plain (non-security-scoped) bookmarks: Reverie is not sandboxed, so no
// entitlement is required. The blob lives in Reverie's database, never in the
// folder. Exposed as a tiny C ABI the Rust `bookmark` module wraps.

#import <Foundation/Foundation.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// Mint a bookmark for the directory at `path`. On success allocates `*out`
// (malloc) with the bookmark bytes, sets `*out_len`, and returns true; the caller
// frees `*out` via `reverie_bookmark_free`. Returns false if the path can't be
// represented or Foundation declines to create a bookmark (e.g. it doesn't exist).
bool reverie_bookmark_create(const char *path, uint8_t **out, size_t *out_len) {
  @autoreleasepool {
    if (path == NULL || out == NULL || out_len == NULL) {
      return false;
    }
    NSString *p = [NSString stringWithUTF8String:path];
    if (p == nil) {
      return false;
    }
    NSURL *url = [NSURL fileURLWithPath:p isDirectory:YES];
    if (url == nil) {
      return false;
    }
    NSError *err = nil;
    NSData *data = [url bookmarkDataWithOptions:0
                includingResourceValuesForKeys:nil
                                 relativeToURL:nil
                                         error:&err];
    if (data == nil) {
      return false;
    }
    size_t len = (size_t)data.length;
    uint8_t *buf = (uint8_t *)malloc(len > 0 ? len : 1);
    if (buf == NULL) {
      return false;
    }
    memcpy(buf, data.bytes, len);
    *out = buf;
    *out_len = len;
    return true;
  }
}

// Resolve a bookmark blob to the folder's current path. On success writes a
// NUL-terminated UTF-8 path into `out_path` (capacity `out_cap`), sets
// `*is_stale` when the bookmark needed refreshing, and returns true. Returns
// false if the blob is unparseable, the folder can't be located (deleted, on an
// unmounted or different volume), or the path doesn't fit `out_cap`.
bool reverie_bookmark_resolve(const uint8_t *data, size_t len, char *out_path,
                              size_t out_cap, bool *is_stale) {
  @autoreleasepool {
    if (data == NULL || out_path == NULL || out_cap == 0) {
      return false;
    }
    NSData *blob = [NSData dataWithBytes:data length:len];
    BOOL stale = NO;
    NSError *err = nil;
    NSURL *url = [NSURL URLByResolvingBookmarkData:blob
                                           options:0
                                     relativeToURL:nil
                               bookmarkDataIsStale:&stale
                                             error:&err];
    if (url == nil) {
      return false;
    }
    if (is_stale != NULL) {
      *is_stale = (stale == YES);
    }
    const char *fs = url.path.fileSystemRepresentation;
    if (fs == NULL) {
      return false;
    }
    size_t n = strlen(fs);
    if (n + 1 > out_cap) {
      return false;
    }
    memcpy(out_path, fs, n + 1);
    return true;
  }
}

void reverie_bookmark_free(uint8_t *ptr) { free(ptr); }
