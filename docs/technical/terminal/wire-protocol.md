# Terminal wire protocol (the boundary)

> What crosses between the Rust backend and the WebView, and the rules that keep it fast. The backend pushes frames and serves history ranges on request; the frontend paints and drives scrolling. See [`architecture.md`](architecture.md).

## Messages (v0)

Backend to frontend:

1. **Seed snapshot.** On attach, focus, or resize. The current screen plus a margin of rows around it (not the whole buffer), with a generation marker. Lets the frontend render and scroll immediately.
2. **Frame diff.** The rows that changed since the last update. The frequent, tiny message.
3. **History-range reply.** Rows the frontend asked for, read from `libghostty`'s buffer, tagged with the generation they belong to.
4. **Control.** Cursor position and shape, title, bell, size.

Frontend to backend:

5. **Input.** Encoded keys, paste, mouse, focus.
6. **History-range request.** "Send me N rows above the oldest row I have," or an explicit row range, tagged with the current generation. Sent when the user scrolls up and the mirror is running low.
7. **Resize.** New cols and rows.

The history-range request reaches only as far as `libghostty`'s in-memory buffer. Rows past the oldest the buffer holds have evicted and are gone; we persist nothing, so there is nothing further to request. A restart resumes the CLI instead (D5).

## The per-cell record

Each cell is a few bytes, packed binary, decoded straight into the typed arrays the renderer wants:

- the character or grapheme (a codepoint, or a small cluster reference),
- display width (so wide CJK and emoji cells are placed correctly),
- foreground color and background color (packed),
- a style bitfield (bold, italic, underline, inverse, and so on).

A row on the wire is its position plus a run of these. A frame or reply is a small header (kind, dimensions, cursor, generation) plus its rows.

## Transport

Use Tauri 2's binary-capable, ordered transports:

- a streaming **Channel** for the backend-to-frontend stream (it is ordered, fast, and is what Tauri uses internally for streaming child-process output),
- **Raw Requests** for the request/reply shapes (history-range request and reply fit this well, in binary).

Do not use the JSON event system for frames or rows. Tauri documents events as JSON strings, not designed for low-latency or high-throughput streams, and the Rust-to-frontend event path cannot send binary. One ordered stream per session, or a single multiplexed stream keyed by session id.

## Rules that keep it fast

- **Binary, not JSON.** Cell data is bytes, not objects.
- **Diffs, not snapshots, on the steady path.** A full snapshot crosses only on attach, focus, or resize.
- **Coalesce.** For the focused session, collapse a burst of changes to at most one frame per frame budget (about 16ms). Background sessions throttle hard or suspend.
- **Prefetch, do not poll.** The frontend asks for more history rows when it is getting close to the edge of its mirror, not on every scroll tick. One request brings back a band of rows, not a row at a time.
- **Bound the work.** If the frontend falls behind, coalesce more aggressively (replace queued diffs with a newer combined diff, or a fresh snapshot). Never grow an unbounded queue.

## Sequencing and correctness

- A session stream reads as: a snapshot, then diffs applied on top of it, then occasionally a new snapshot that resets the baseline. History-range replies fill in rows above the snapshot.
- A single ordered Channel makes frames per session strictly ordered.
- The **generation marker** is the key to correctness across resize. A resize bumps the generation, because `libghostty` reflows scrollback and row numbering changes. The frontend discards any in-flight diff or history reply that predates the latest snapshot, and re-issues history-range requests against the new generation. It never merges rows from two different generations.
- The frontend applies diffs onto its mirror; if it detects a gap it cannot reconcile, it asks for a fresh snapshot rather than guessing.

## Why this shape

Minimal bytes on the wire, minimal decode on the frontend, no per-frame full grid, and no round-trip on the scroll hot path. The history-range request is the one place the frontend pulls from the backend, and it is deliberately a background top-up, not a synchronous step in scrolling. That combination is the difference between a smooth 60fps terminal and the scroll lag this design exists to avoid. The lesson is borrowed from Ghostty's own renderer, which abandoned per-frame full-grid copies because the copy time blocked output even in-process; across a serialized boundary the discipline matters more, not less.
