//! Pattern alphabet: a bit mask of where each UTF-16 code unit sits in the pattern.
//! Fuse builds this with `charAt`, so the key is one code unit, not a scalar value.

use std::collections::HashMap;

#[derive(Clone, Debug)]
pub enum Alphabet {
    /// Every pattern code unit is < 128. Boxed so the enum stays small; the
    /// table is built once per pattern chunk and then only read.
    Ascii(Box<[u32; 128]>),
    Map(HashMap<u16, u32>),
}

impl Alphabet {
    pub fn from_pattern(pattern: &[u16]) -> Self {
        let ascii = pattern.iter().all(|c| *c < 128);
        if ascii {
            let mut table = Box::new([0u32; 128]);
            let len = pattern.len();
            for (i, &ch) in pattern.iter().enumerate() {
                table[ch as usize] |= 1u32 << (len - i - 1);
            }
            Alphabet::Ascii(table)
        } else {
            let mut map = HashMap::new();
            let len = pattern.len();
            for (i, &ch) in pattern.iter().enumerate() {
                let entry = map.entry(ch).or_insert(0);
                *entry |= 1u32 << (len - i - 1);
            }
            Alphabet::Map(map)
        }
    }

    #[inline]
    pub fn get(&self, ch: u16) -> u32 {
        match self {
            Alphabet::Ascii(table) => {
                if ch < 128 {
                    table[ch as usize]
                } else {
                    0
                }
            }
            Alphabet::Map(map) => map.get(&ch).copied().unwrap_or(0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_match_js_shifts() {
        let p: Vec<u16> = "abc".encode_utf16().collect();
        let a = Alphabet::from_pattern(&p);
        // len 3: 'a' is bit 2, 'b' bit 1, 'c' bit 0.
        assert_eq!(a.get(b'a' as u16), 0b100);
        assert_eq!(a.get(b'b' as u16), 0b010);
        assert_eq!(a.get(b'c' as u16), 0b001);
        assert_eq!(a.get(b'z' as u16), 0);
    }

    #[test]
    fn repeated_char_ors_bits() {
        let p: Vec<u16> = "aa".encode_utf16().collect();
        let a = Alphabet::from_pattern(&p);
        assert_eq!(a.get(b'a' as u16), 0b11);
    }
}
