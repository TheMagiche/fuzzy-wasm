//! Case folding and diacritic stripping.
//!
//! The TypeScript wrapper folds case with JavaScript `String#toLowerCase`
//! before text ever reaches WASM. That is the only fold that matches Fuse,
//! because JS applies Unicode Default Case Conversion (final sigma, `İ` →
//! `i` + combining dot, and other length-changing mappings).
//!
//! This module still implements Fuse's `stripDiacritics` (NFD, drop the same
//! combining-mark ranges, then map letters that do not decompose). It is used
//! by native callers and covered by unit tests. Search itself runs on text
//! the host has already normalized, so match indices line up with Fuse.

use unicode_normalization::UnicodeNormalization;

/// Letters Fuse maps explicitly because NFD leaves them unchanged.
fn map_non_decomposable(ch: char) -> Option<&'static str> {
    Some(match ch {
        '\u{0142}' => "l",  // ł
        '\u{0141}' => "L",  // Ł
        '\u{0111}' => "d",  // đ
        '\u{0110}' => "D",  // Đ
        '\u{00F8}' => "o",  // ø
        '\u{00D8}' => "O",  // Ø
        '\u{0127}' => "h",  // ħ
        '\u{0126}' => "H",  // Ħ
        '\u{0167}' => "t",  // ŧ
        '\u{0166}' => "T",  // Ŧ
        '\u{0131}' => "i",  // ı
        '\u{00DF}' => "ss", // ß
        _ => return None,
    })
}

fn is_combining_mark(ch: char) -> bool {
    let c = ch as u32;
    (0x0300..=0x036F).contains(&c)
        || (0x0483..=0x0489).contains(&c)
        || (0x0591..=0x05BD).contains(&c)
        || c == 0x05BF
        || c == 0x05C1
        || c == 0x05C2
        || c == 0x05C4
        || c == 0x05C5
        || c == 0x05C7
        || (0x0610..=0x061A).contains(&c)
        || (0x064B..=0x065F).contains(&c)
        || c == 0x0670
        || (0x06D6..=0x06DC).contains(&c)
        || (0x06DF..=0x06E4).contains(&c)
        || c == 0x06E7
        || c == 0x06E8
        || (0x06EA..=0x06ED).contains(&c)
        || c == 0x0711
        || (0x0730..=0x074A).contains(&c)
        || (0x07A6..=0x07B0).contains(&c)
        || (0x07EB..=0x07F3).contains(&c)
        || c == 0x07FD
        || (0x0816..=0x0819).contains(&c)
        || (0x081B..=0x0823).contains(&c)
        || (0x0825..=0x0827).contains(&c)
        || (0x0829..=0x082D).contains(&c)
        || (0x0859..=0x085B).contains(&c)
        || (0x08D3..=0x08E1).contains(&c)
        || (0x08E3..=0x0903).contains(&c)
        || (0x093A..=0x093C).contains(&c)
        || (0x093E..=0x094F).contains(&c)
        || (0x0951..=0x0957).contains(&c)
        || c == 0x0962
        || c == 0x0963
        || (0x0981..=0x0983).contains(&c)
        || c == 0x09BC
        || (0x09BE..=0x09C4).contains(&c)
        || c == 0x09C7
        || c == 0x09C8
        || (0x09CB..=0x09CD).contains(&c)
        || c == 0x09D7
        || c == 0x09E2
        || c == 0x09E3
        || c == 0x09FE
        || (0x0A01..=0x0A03).contains(&c)
        || c == 0x0A3C
        || (0x0A3E..=0x0A42).contains(&c)
        || c == 0x0A47
        || c == 0x0A48
        || (0x0A4B..=0x0A4D).contains(&c)
        || c == 0x0A51
        || c == 0x0A70
        || c == 0x0A71
        || c == 0x0A75
        || (0x0A81..=0x0A83).contains(&c)
        || c == 0x0ABC
        || (0x0ABE..=0x0AC5).contains(&c)
        || (0x0AC7..=0x0AC9).contains(&c)
        || (0x0ACB..=0x0ACD).contains(&c)
        || c == 0x0AE2
        || c == 0x0AE3
        || (0x0AFA..=0x0AFF).contains(&c)
        || (0x0B01..=0x0B03).contains(&c)
        || c == 0x0B3C
        || (0x0B3E..=0x0B44).contains(&c)
        || c == 0x0B47
        || c == 0x0B48
        || (0x0B4B..=0x0B4D).contains(&c)
        || c == 0x0B56
        || c == 0x0B57
        || c == 0x0B62
        || c == 0x0B63
        || c == 0x0B82
        || (0x0BBE..=0x0BC2).contains(&c)
        || (0x0BC6..=0x0BC8).contains(&c)
        || (0x0BCA..=0x0BCD).contains(&c)
        || c == 0x0BD7
        || (0x0C00..=0x0C04).contains(&c)
        || (0x0C3E..=0x0C44).contains(&c)
        || (0x0C46..=0x0C48).contains(&c)
        || (0x0C4A..=0x0C4D).contains(&c)
        || c == 0x0C55
        || c == 0x0C56
        || c == 0x0C62
        || c == 0x0C63
        || (0x0C81..=0x0C83).contains(&c)
        || c == 0x0CBC
        || (0x0CBE..=0x0CC4).contains(&c)
        || (0x0CC6..=0x0CC8).contains(&c)
        || (0x0CCA..=0x0CCD).contains(&c)
        || c == 0x0CD5
        || c == 0x0CD6
        || c == 0x0CE2
        || c == 0x0CE3
        || (0x0D00..=0x0D03).contains(&c)
        || c == 0x0D3B
        || c == 0x0D3C
        || (0x0D3E..=0x0D44).contains(&c)
        || (0x0D46..=0x0D48).contains(&c)
        || (0x0D4A..=0x0D4D).contains(&c)
        || c == 0x0D57
        || c == 0x0D62
        || c == 0x0D63
        || c == 0x0D82
        || c == 0x0D83
        || c == 0x0DCA
        || (0x0DCF..=0x0DD4).contains(&c)
        || c == 0x0DD6
        || (0x0DD8..=0x0DDF).contains(&c)
        || c == 0x0DF2
        || c == 0x0DF3
        || c == 0x0E31
        || (0x0E34..=0x0E3A).contains(&c)
        || (0x0E47..=0x0E4E).contains(&c)
        || c == 0x0EB1
        || (0x0EB4..=0x0EB9).contains(&c)
        || c == 0x0EBB
        || c == 0x0EBC
        || (0x0EC8..=0x0ECD).contains(&c)
        || c == 0x0F18
        || c == 0x0F19
        || c == 0x0F35
        || c == 0x0F37
        || c == 0x0F39
        || c == 0x0F3E
        || c == 0x0F3F
        || (0x0F71..=0x0F84).contains(&c)
        || c == 0x0F86
        || c == 0x0F87
        || (0x0F8D..=0x0F97).contains(&c)
        || (0x0F99..=0x0FBC).contains(&c)
        || c == 0x0FC6
        || (0x102B..=0x103E).contains(&c)
        || (0x1056..=0x1059).contains(&c)
        || (0x105E..=0x1060).contains(&c)
        || (0x1062..=0x1064).contains(&c)
        || (0x1067..=0x106D).contains(&c)
        || (0x1071..=0x1074).contains(&c)
        || (0x1082..=0x108D).contains(&c)
        || c == 0x108F
        || (0x109A..=0x109D).contains(&c)
        || (0x135D..=0x135F).contains(&c)
        || (0x1712..=0x1714).contains(&c)
        || (0x1732..=0x1734).contains(&c)
        || c == 0x1752
        || c == 0x1753
        || c == 0x1772
        || c == 0x1773
        || (0x17B4..=0x17D3).contains(&c)
        || c == 0x17DD
        || (0x180B..=0x180D).contains(&c)
        || c == 0x1885
        || c == 0x1886
        || c == 0x18A9
        || (0x1920..=0x192B).contains(&c)
        || (0x1930..=0x193B).contains(&c)
        || (0x1A17..=0x1A1B).contains(&c)
        || (0x1A55..=0x1A5E).contains(&c)
        || (0x1A60..=0x1A7C).contains(&c)
        || c == 0x1A7F
        || (0x1AB0..=0x1ABE).contains(&c)
        || (0x1B00..=0x1B04).contains(&c)
        || (0x1B34..=0x1B44).contains(&c)
        || (0x1B6B..=0x1B73).contains(&c)
        || (0x1B80..=0x1B82).contains(&c)
        || (0x1BA1..=0x1BAD).contains(&c)
        || (0x1BE6..=0x1BF3).contains(&c)
        || (0x1C24..=0x1C37).contains(&c)
        || (0x1CD0..=0x1CD2).contains(&c)
        || (0x1CD4..=0x1CE8).contains(&c)
        || c == 0x1CED
        || (0x1CF2..=0x1CF4).contains(&c)
        || (0x1CF7..=0x1CF9).contains(&c)
        || (0x1DC0..=0x1DF9).contains(&c)
        || (0x1DFB..=0x1DFF).contains(&c)
        || (0x20D0..=0x20F0).contains(&c)
        || (0x2CEF..=0x2CF1).contains(&c)
        || c == 0x2D7F
        || (0x2DE0..=0x2DFF).contains(&c)
        || (0x302A..=0x302F).contains(&c)
        || c == 0x3099
        || c == 0x309A
        || (0xA66F..=0xA672).contains(&c)
        || (0xA674..=0xA67D).contains(&c)
        || c == 0xA69E
        || c == 0xA69F
        || c == 0xA6F0
        || c == 0xA6F1
        || c == 0xA802
        || c == 0xA806
        || c == 0xA80B
        || (0xA823..=0xA827).contains(&c)
        || c == 0xA880
        || c == 0xA881
        || (0xA8B4..=0xA8C5).contains(&c)
        || (0xA8E0..=0xA8F1).contains(&c)
        || c == 0xA8FF
        || (0xA926..=0xA92D).contains(&c)
        || (0xA947..=0xA953).contains(&c)
        || (0xA980..=0xA983).contains(&c)
        || (0xA9B3..=0xA9C0).contains(&c)
        || c == 0xA9E5
        || (0xAA29..=0xAA36).contains(&c)
        || c == 0xAA43
        || c == 0xAA4C
        || c == 0xAA4D
        || (0xAA7B..=0xAA7D).contains(&c)
        || c == 0xAAB0
        || (0xAAB2..=0xAAB4).contains(&c)
        || c == 0xAAB7
        || c == 0xAAB8
        || c == 0xAABE
        || c == 0xAABF
        || c == 0xAAC1
        || (0xAAEB..=0xAAEF).contains(&c)
        || c == 0xAAF5
        || c == 0xAAF6
        || (0xABE3..=0xABEA).contains(&c)
        || c == 0xABEC
        || c == 0xABED
        || c == 0xFB1E
        || (0xFE00..=0xFE0F).contains(&c)
        || (0xFE20..=0xFE2F).contains(&c)
}

/// Strip diacritics the way Fuse.js `stripDiacritics` does.
pub fn strip_diacritics(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.nfd() {
        if is_combining_mark(ch) {
            continue;
        }
        if let Some(mapped) = map_non_decomposable(ch) {
            out.push_str(mapped);
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_common_accents_and_specials() {
        assert_eq!(strip_diacritics("café"), "cafe");
        assert_eq!(strip_diacritics("naïve"), "naive");
        assert_eq!(strip_diacritics("Łódź"), "Lodz");
        assert_eq!(strip_diacritics("ångström"), "angstrom");
        assert_eq!(strip_diacritics("straße"), "strasse");
        assert_eq!(strip_diacritics("你好"), "你好");
    }
}
