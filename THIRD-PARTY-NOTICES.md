# Third-Party Notices

Reverie is distributed under the [MIT License](LICENSE). It builds on a number
of open-source components that carry their own licenses. This file acknowledges
the major ones. It is not exhaustive: the full Rust and npm dependency trees
include additional transitive dependencies, each governed by its own license.

To regenerate complete dependency-license lists:

```bash
# Rust (install with: cargo install cargo-license)
cargo license

# npm (install with: npm i -g license-checker-rspack)
license-checker-rspack --summary
```

## Terminal core

Reverie's terminal emulation is provided by Ghostty's VT core, linked through
the `libghostty-vt` Rust bindings.

- **Ghostty** (`libghostty-vt-sys` vendors and builds the Ghostty source) is
  licensed under the MIT License:

  > MIT License
  >
  > Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors
  >
  > Permission is hereby granted, free of charge, to any person obtaining a copy
  > of this software and associated documentation files (the "Software"), to deal
  > in the Software without restriction [...]

- **libghostty-vt / libghostty-vt-sys** (the Rust bindings) are licensed under
  `MIT OR Apache-2.0`. See <https://github.com/uzaaft/libghostty-rs>.

Building the terminal core requires the Zig toolchain (`0.15.x`). Zig itself is
licensed under the MIT License and is used as a build tool, not redistributed.

## Major components

| Component | Role | License |
| --- | --- | --- |
| [Tauri](https://github.com/tauri-apps/tauri) | Desktop shell / WebView runtime | MIT OR Apache-2.0 |
| [portable-pty](https://github.com/wezterm/wezterm) (wezterm) | Cross-platform PTY / process spawn | MIT |
| [SQLite](https://www.sqlite.org/) (via `rusqlite`, bundled) | Local persistence | Public Domain (SQLite); MIT (`rusqlite`) |
| [React](https://github.com/facebook/react) | Product shell UI | MIT |
| [Vite](https://github.com/vitejs/vite) | Frontend build tool | MIT |
| [Panda CSS](https://github.com/chakra-ui/panda) | Styling / tokens | MIT |
| [Motion](https://github.com/motiondivision/motion) | Shell-level animation | MIT |
| [Phosphor Icons](https://github.com/phosphor-icons/react) | App-shell iconography | MIT |
| [Zustand](https://github.com/pmndrs/zustand) | Frontend state | MIT |
| `serde`, `serde_json` | Serialization | MIT OR Apache-2.0 |
| `anyhow`, `thiserror` | Error handling | MIT OR Apache-2.0 |
| `uuid` | Identifiers | MIT OR Apache-2.0 |
| `notify`, `notify-debouncer-full` | Filesystem watching | MIT / CC0 |
| `tiny_http` | Local hook server | MIT OR Apache-2.0 |
| `toml`, `toml_edit` | Config writing | MIT OR Apache-2.0 |
| `rfd` | Native file dialogs | MIT |

All listed components are distributed under permissive licenses compatible with
Reverie's MIT license.
