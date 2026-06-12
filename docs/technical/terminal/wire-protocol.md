# Terminal wire protocol (the boundary)

> What crosses between the Rust backend and the WebView, and the rules that keep it fast. The backend pushes frames and serves history ranges on request; the frontend paints and drives scrolling. See [`architecture.md`](architecture.md).

## Messages (v0)

Backend to frontend:

1. **Seed snapshot.** On attach, focus, or resize. The current viewport rows only (not the whole buffer, and no surrounding margin), with a generation marker. Lets the frontend render immediately; older history is fetched on demand via history-range row bands, never carried in the seed.
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

## Binary frame encoding (concrete)

The frame stream over the Channel is a compact little-endian binary encoding of Reverie's `TerminalFrame`. Each `Channel.send` carries exactly one frame message; the Channel preserves message boundaries and order, so no inter-message length prefix is needed. The frontend decodes each message back into the same `TerminalFrame` shape the buffer already consumes. This encoding changes the transport and serialization only, not the frame semantics (rows stay viewport-relative with a scrollback offset, as today).

All integers little-endian. A frame message:

```
u8    kind            // 1 = frame
u32   generation      // per-session, bumped on resize
u8    dirty           // 0 Clean, 1 Partial (diff), 2 Full (snapshot/seed)
u16   cols
u16   rows            // viewport rows
Cursor                // u8 flags (bit0 visible, bit1 blinking, bit2 has_position),
                      // u8 style (0 Block,1 BlockHollow,2 Bar,3 Underline),
                      // u16 col, u16 row  (col/row present only if has_position)
Modes                 // u16 flags (bit0 cursor_key_app,1 keypad_app,2 bracketed_paste,
                      //   3 sync_output,4 mouse_tracking,5 alternate_screen), u8 kitty_flags
Colors                // Color fg, Color bg, u8 has_cursor, Color cursor (if has_cursor)
Scrollback            // u32 total_rows, u32 scrollback_rows, u32 viewport_offset,
                      //   u32 viewport_rows, u8 at_bottom, u64 oldest_id
                      //   (oldest_id = stable-id floor / rows evicted; D8)
u32   row_count
Row[] rows

Row    = u16 index (viewport-relative), u8 dirty, u16 cell_count, Cell[] cells
Cell   = u16 col, u16 width, u16 style, u8 color_flags,
         Color fg (if color_flags bit0), Color bg (if color_flags bit1),
         u16 text_len, u8[text_len] utf8   // grapheme cluster
Color  = u8 r, u8 g, u8 b
```

`Cell.style` bits: 0 bold, 1 italic, 2 faint, 3 blink, 4 invisible, 5 inverse, 6 strikethrough, 7 overline; bits 8 to 10 hold the underline kind (0 None, 1 Single, 2 Double, 3 Curly, 4 Dotted, 5 Dashed).

Generation rules: the frontend tracks the latest generation it has seen. A `Full` frame adopts its generation and rebuilds the mirror; a frame whose generation is older than the latest is dropped; a resize bumps the backend generation and is immediately followed by a `Full` frame. Control and lifecycle messages (`terminal_stream_started`, `terminal_exit`, `terminal_failed`, title, bell) stay low-rate JSON events for now; only the frame stream is binary. The decoder is shared between the Tauri Channel path and the harness bridge's transport, so both exercise the same wire format.

## Transport

Use Tauri 2's binary-capable, ordered transports:

- a streaming **Channel** for the backend-to-frontend stream (it is ordered, fast, and is what Tauri uses internally for streaming child-process output),
- **a Tauri command returning binary** for the request/reply shapes (the history-range request and reply ride the `read_terminal_rows` command, which returns a `Vec<u8>` the frontend receives as an `ArrayBuffer`).

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

## History-range request and reply

When the user scrolls up and the frontend's mirror runs low on older rows, the frontend pulls a band of rows from the backend. This is a request/reply (the `read_terminal_rows` Tauri command, which returns binary), not part of the frame Channel.

The request (frontend to backend) is tiny and infrequent, so it travels as ordinary command arguments: the terminal id, the `start_id` (a stable row id, not a buffer position; see decisions.md D8), the `count` of rows wanted, and the `generation` the frontend currently holds. The backend maps `start_id` to a buffer position with the live floor (`pos = start_id - oldest_id`, clamped), serves the rows from `libghostty`'s live buffer (see [`backend.md`](backend.md) for the mechanism), and replies with a binary row band stamped with the id it actually served from:

```
Row band reply (little-endian)
u8   kind            // 2 = row band
u32  generation      // the generation the rows were read at
u64  start_id        // stable id of the first row in the band (served floor)
u32  row_count
BandRow[] rows
BandRow = u16 cell_count, Cell[] cells   // Cell encoded exactly as in a frame
```

Band rows are contiguous from stable id `start_id`, so they carry no per-row index or dirty flag; the `Cell` encoding is identical to the frame encoding, shared by one encoder and one decoder. The frontend converts `start_id` back to a current buffer position (`start_id - oldest_id`) and merges the rows there, only if `generation` still matches the latest it holds; a band a resize has invalidated is dropped and re-requested against the new generation. Reach is `libghostty`'s scrollback budget; a request past the oldest row it holds returns an empty band.

## Why this shape

Minimal bytes on the wire, minimal decode on the frontend, no per-frame full grid, and no round-trip on the scroll hot path. The history-range request is the one place the frontend pulls from the backend, and it is deliberately a background top-up, not a synchronous step in scrolling. That combination is the difference between a smooth 60fps terminal and the scroll lag this design exists to avoid. The lesson is borrowed from Ghostty's own renderer, which abandoned per-frame full-grid copies because the copy time blocked output even in-process; across a serialized boundary the discipline matters more, not less.
