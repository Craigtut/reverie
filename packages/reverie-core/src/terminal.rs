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
pub struct TerminalFrame {
    pub dirty: TerminalDirtyState,
    #[serde(default)]
    pub cols: u16,
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
    pub alternate_screen: bool,
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
        let mut cells = self.cells.iter().collect::<Vec<_>>();
        cells.sort_by_key(|cell| cell.col);
        let mut out = String::new();
        let mut col = 0_u16;
        for cell in cells {
            while col < cell.col {
                out.push(' ');
                col = col.saturating_add(1);
            }
            out.push_str(&cell.text);
            col = cell.col.saturating_add(cell.width.max(1));
        }
        out
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TerminalCell {
    pub col: u16,
    #[serde(default = "default_cell_width")]
    pub width: u16,
    pub text: String,
    pub fg: Option<TerminalColor>,
    pub bg: Option<TerminalColor>,
    pub style: TerminalCellStyle,
}

fn default_cell_width() -> u16 {
    1
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TerminalCellStyle {
    pub bold: bool,
    pub italic: bool,
    #[serde(default)]
    pub faint: bool,
    #[serde(default)]
    pub blink: bool,
    #[serde(default)]
    pub invisible: bool,
    pub underline: TerminalUnderline,
    pub inverse: bool,
    #[serde(default)]
    pub strikethrough: bool,
    #[serde(default)]
    pub overline: bool,
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

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

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
                    width: 7,
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
                        faint: false,
                        blink: false,
                        invisible: false,
                        underline: TerminalUnderline::None,
                        inverse: false,
                        strikethrough: false,
                        overline: false,
                    },
                },
                TerminalCell {
                    col: 7,
                    width: 1,
                    text: " ".to_string(),
                    fg: None,
                    bg: None,
                    style: TerminalCellStyle {
                        bold: false,
                        italic: false,
                        faint: false,
                        blink: false,
                        invisible: false,
                        underline: TerminalUnderline::None,
                        inverse: false,
                        strikethrough: false,
                        overline: false,
                    },
                },
                TerminalCell {
                    col: 8,
                    width: 1,
                    text: "-".to_string(),
                    fg: None,
                    bg: None,
                    style: TerminalCellStyle {
                        bold: false,
                        italic: false,
                        faint: false,
                        blink: false,
                        invisible: false,
                        underline: TerminalUnderline::Single,
                        inverse: false,
                        strikethrough: false,
                        overline: false,
                    },
                },
            ],
        };

        assert_eq!(row.plain_text(), "Reverie -");
    }
}
