//! Field-length norm, ported from Fuse.js `tools/fieldNorm.ts`.
//!
//! Shorter fields weigh more. The value is rounded to 3 decimal places so an
//! index stays small and stable: `round(1000 / tokens^(0.5 * weight)) / 1000`.

/// ASCII whitespace Fuse counts as a word break: tab through CR, space, NBSP.
#[inline]
pub fn is_word_separator(code: u16) -> bool {
    (9..=13).contains(&code) || code == 32 || code == 160
}

/// Count words the way Fuse does: transitions from separator (or start) into
/// a non-separator. Empty and all-whitespace strings count as one token so
/// the formula never divides by zero.
pub fn word_count(text: &[u16]) -> u32 {
    let mut num_tokens = 0u32;
    let mut in_word = false;
    for &code in text {
        if !is_word_separator(code) {
            if !in_word {
                num_tokens += 1;
                in_word = true;
            }
        } else {
            in_word = false;
        }
    }
    if num_tokens == 0 {
        1
    } else {
        num_tokens
    }
}

pub fn field_norm(text: &[u16], weight: f64) -> f64 {
    let tokens = word_count(text) as f64;
    let m = 1000.0;
    (m / tokens.powf(0.5 * weight)).round() / m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u16s(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn norms_match_fuse_fixtures() {
        // Captured from fuse.js 7.5 `Fuse.createIndex`.
        assert_eq!(field_norm(&u16s("The Old Man and the Sea"), 1.0), 0.408);
        assert_eq!(field_norm(&u16s("Old Man's War"), 1.0), 0.577);
        assert_eq!(field_norm(&u16s("hello world"), 1.0), 0.707);
        assert_eq!(field_norm(&u16s("hello"), 1.0), 1.0);
        assert_eq!(field_norm(&u16s(""), 1.0), 1.0);
        assert_eq!(field_norm(&u16s("   "), 1.0), 1.0);
        assert_eq!(field_norm(&u16s("a\tb"), 1.0), 0.707);
        assert_eq!(field_norm(&u16s("  a  b  "), 1.0), 0.707);
        assert_eq!(word_count(&u16s("a\u{00a0}b")), 2);
    }
}
