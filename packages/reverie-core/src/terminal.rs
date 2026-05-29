use std::path::PathBuf;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::agents::CommandSpec;

pub type TerminalId = Uuid;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TerminalSpawnSpec {
    pub command: CommandSpec,
    pub cols: u16,
    pub rows: u16,
    pub title: Option<String>,
}

impl TerminalSpawnSpec {
    pub fn new(command: CommandSpec) -> Self {
        Self {
            command,
            cols: 120,
            rows: 32,
            title: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TerminalSnapshot {
    pub id: TerminalId,
    pub cols: u16,
    pub rows: u16,
    pub cwd: PathBuf,
    pub frame: TerminalFrame,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TerminalFrame {
    pub dirty: TerminalDirtyState,
    pub colors: TerminalColors,
    pub cursor: TerminalCursor,
    #[serde(default)]
    pub modes: TerminalModes,
    #[serde(default)]
    pub scrollback: TerminalScrollback,
    pub rows: Vec<TerminalRow>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalDirtyState {
    Clean,
    Partial,
    Full,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TerminalColors {
    pub foreground: TerminalColor,
    pub background: TerminalColor,
    pub cursor: Option<TerminalColor>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalModes {
    pub cursor_key_application: bool,
    pub keypad_key_application: bool,
    pub bracketed_paste: bool,
    pub sync_output: bool,
    pub mouse_tracking: bool,
    pub kitty_keyboard_flags: u8,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalScrollback {
    pub total_rows: usize,
    pub scrollback_rows: usize,
    pub viewport_offset: usize,
    pub viewport_rows: usize,
    pub at_bottom: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TerminalColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TerminalCursor {
    pub visible: bool,
    pub blinking: bool,
    pub style: TerminalCursorStyle,
    pub position: Option<TerminalPosition>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalCursorStyle {
    Block,
    BlockHollow,
    Bar,
    Underline,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TerminalPosition {
    pub col: u16,
    pub row: u16,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TerminalRow {
    pub index: u16,
    pub dirty: bool,
    pub cells: Vec<TerminalCell>,
}

impl TerminalRow {
    pub fn plain_text(&self) -> String {
        self.cells.iter().map(|cell| cell.text.as_str()).collect()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TerminalCell {
    pub col: u16,
    pub text: String,
    pub fg: Option<TerminalColor>,
    pub bg: Option<TerminalColor>,
    pub style: TerminalCellStyle,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TerminalCellStyle {
    pub bold: bool,
    pub italic: bool,
    pub underline: TerminalUnderline,
    pub inverse: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalUnderline {
    None,
    Single,
    Double,
    Curly,
    Dotted,
    Dashed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TerminalFramePatch {
    pub dirty: TerminalDirtyState,
    pub colors: Option<TerminalColors>,
    pub cursor: TerminalCursor,
    pub rows: Vec<TerminalRow>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalEvent {
    Output {
        terminal_id: TerminalId,
        bytes: Vec<u8>,
    },
    FrameChanged {
        terminal_id: TerminalId,
        patch: TerminalFramePatch,
    },
    SnapshotChanged {
        terminal_id: TerminalId,
    },
    Resized {
        terminal_id: TerminalId,
        cols: u16,
        rows: u16,
    },
    Exited {
        terminal_id: TerminalId,
        exit_code: Option<i32>,
    },
}

/// Terminal service boundary used by the app layer.
///
/// Implementations may be backed by Ghostty VT state, another renderer, or a
/// test double. Reverie's product/domain model should never depend on which
/// backend is active.
pub trait TerminalBackend {
    fn spawn(&mut self, spec: TerminalSpawnSpec) -> Result<TerminalId>;
    fn write_input(&mut self, terminal_id: TerminalId, bytes: &[u8]) -> Result<()>;
    fn resize(&mut self, terminal_id: TerminalId, cols: u16, rows: u16) -> Result<()>;
    fn snapshot(&self, terminal_id: TerminalId) -> Result<TerminalSnapshot>;
    fn drain_events(&mut self, terminal_id: TerminalId) -> Result<Vec<TerminalEvent>>;
    fn terminate(&mut self, terminal_id: TerminalId) -> Result<()>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_spawn_spec_has_product_safe_defaults() {
        let command = CommandSpec::new("cortex", "/tmp/reverie");
        let spec = TerminalSpawnSpec::new(command);

        assert_eq!(spec.cols, 120);
        assert_eq!(spec.rows, 32);
        assert_eq!(spec.command.program, PathBuf::from("cortex"));
    }

    #[test]
    fn terminal_rows_preserve_renderable_cell_text() {
        let row = TerminalRow {
            index: 0,
            dirty: true,
            cells: vec![
                TerminalCell {
                    col: 0,
                    text: "Reverie".to_string(),
                    fg: Some(TerminalColor {
                        r: 0xff,
                        g: 0xff,
                        b: 0xff,
                    }),
                    bg: None,
                    style: TerminalCellStyle {
                        bold: true,
                        italic: false,
                        underline: TerminalUnderline::None,
                        inverse: false,
                    },
                },
                TerminalCell {
                    col: 7,
                    text: " ".to_string(),
                    fg: None,
                    bg: None,
                    style: TerminalCellStyle {
                        bold: false,
                        italic: false,
                        underline: TerminalUnderline::None,
                        inverse: false,
                    },
                },
                TerminalCell {
                    col: 8,
                    text: "—".to_string(),
                    fg: None,
                    bg: None,
                    style: TerminalCellStyle {
                        bold: false,
                        italic: false,
                        underline: TerminalUnderline::Single,
                        inverse: false,
                    },
                },
            ],
        };

        assert_eq!(row.plain_text(), "Reverie —");
    }
}
