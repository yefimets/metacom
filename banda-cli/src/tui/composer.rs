use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

#[derive(Clone, Debug, Default)]
pub(super) struct Composer {
    pub text: String,
    pub cursor: usize,
    pub revision: u64,
}

impl Composer {
    pub fn replace(&mut self, text: String) {
        self.cursor = text.len();
        self.text = text;
        self.revision = self.revision.wrapping_add(1);
    }

    pub fn insert(&mut self, text: &str) {
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        let text: String = text
            .chars()
            .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
            .collect();
        self.text.insert_str(self.cursor, &text);
        let after = self.cursor + text.len();
        self.cursor = self.boundary_after(after);
        self.revision = self.revision.wrapping_add(1);
    }

    fn boundary_after(&self, position: usize) -> usize {
        self.text
            .grapheme_indices(true)
            .map(|(i, _)| i)
            .find(|i| *i >= position)
            .unwrap_or(self.text.len())
    }

    pub fn left(&mut self) {
        self.cursor = self.text[..self.cursor]
            .grapheme_indices(true)
            .last()
            .map_or(0, |(i, _)| i);
    }

    pub fn right(&mut self) {
        if let Some(g) = self.text[self.cursor..].graphemes(true).next() {
            self.cursor += g.len();
        }
    }

    pub fn backspace(&mut self) {
        let end = self.cursor;
        self.left();
        if end != self.cursor {
            self.text.replace_range(self.cursor..end, "");
            self.cursor = self.boundary_after(self.cursor);
            self.revision = self.revision.wrapping_add(1);
        }
    }

    pub fn delete(&mut self) {
        if let Some(g) = self.text[self.cursor..].graphemes(true).next() {
            let end = self.cursor + g.len();
            self.text.replace_range(self.cursor..end, "");
            self.cursor = self.boundary_after(self.cursor);
            self.revision = self.revision.wrapping_add(1);
        }
    }

    pub fn home(&mut self) {
        self.cursor = self.text[..self.cursor].rfind('\n').map_or(0, |i| i + 1);
    }

    pub fn end(&mut self) {
        self.cursor += self.text[self.cursor..]
            .find('\n')
            .unwrap_or(self.text.len() - self.cursor);
    }

    pub fn vertical(&mut self, down: bool) {
        let start = self.text[..self.cursor].rfind('\n').map_or(0, |i| i + 1);
        let column = UnicodeWidthStr::width(&self.text[start..self.cursor]);
        let target = if down {
            match self.text[self.cursor..].find('\n') {
                Some(i) => self.cursor + i + 1,
                None => return,
            }
        } else if start > 0 {
            self.text[..start - 1].rfind('\n').map_or(0, |i| i + 1)
        } else {
            return;
        };
        let end = self.text[target..]
            .find('\n')
            .map_or(self.text.len(), |i| target + i);
        self.cursor = target;
        let mut cells = 0;
        for (i, g) in self.text[target..end].grapheme_indices(true) {
            let next = cells + UnicodeWidthStr::width(g);
            if next > column {
                break;
            }
            cells = next;
            self.cursor = target + i + g.len();
        }
    }
}

pub(super) fn safe_text(text: &str) -> String {
    // Hub messages and terminal snapshots are untrusted text, never terminal commands.
    text.chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect()
}

pub(super) fn wrap(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut out = Vec::new();
    for logical in text.split('\n') {
        let mut line = String::new();
        let mut cells = 0;
        for g in logical.graphemes(true) {
            let g = if g == "\t" { "    " } else { g };
            let w = UnicodeWidthStr::width(g);
            if cells > 0 && cells + w > width {
                out.push(std::mem::take(&mut line));
                cells = 0;
            }
            line.push_str(g);
            cells += w;
        }
        out.push(line);
    }
    out
}

pub(super) fn clip(text: &str, width: usize) -> String {
    let mut result = String::new();
    let mut cells = 0;
    for g in text.graphemes(true) {
        let w = UnicodeWidthStr::width(g);
        if cells + w > width {
            break;
        }
        result.push_str(g);
        cells += w;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deleting_combined_emoji_and_combining_marks_is_atomic() {
        let mut input = Composer::default();
        input.insert("a👩🏽‍💻e\u{301}");
        input.backspace();
        assert_eq!(input.text, "a👩🏽‍💻");
        input.left();
        assert_eq!(input.cursor, 1);
        input.delete();
        assert_eq!(input.text, "a");
    }

    #[test]
    fn insertion_keeps_cursor_on_boundary_when_graphemes_merge() {
        let mut input = Composer::default();
        input.insert("👩💻");
        input.left();
        input.insert("\u{200d}");
        assert_eq!(input.cursor, input.text.len());
        input.backspace();
        assert_eq!(input.text, "");
    }

    #[test]
    fn multiline_paste_and_vertical_motion_use_cells() {
        let mut input = Composer::default();
        input.insert("界a\r\nabc\rnext");
        assert_eq!(input.text, "界a\nabc\nnext");
        input.home();
        input.vertical(false);
        input.right();
        input.right();
        input.vertical(false);
        assert_eq!(input.cursor, "界".len());
        assert_eq!(wrap("界界a", 4), vec!["界界", "a"]);
    }
}
