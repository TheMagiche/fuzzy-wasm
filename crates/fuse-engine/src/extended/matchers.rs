//! Matcher factories. Detection order matches Fuse.js `matchers.ts`.

use crate::bitap::{index_of, BitapOutput, BitapParams, BitapSearch, Scratch};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Exact,
    Include,
    Prefix,
    InversePrefix,
    InverseSuffix,
    Suffix,
    InverseExact,
    Fuzzy,
}

pub struct Matcher {
    kind: Kind,
    pattern: Vec<u16>,
    fuzzy: Option<BitapSearch>,
}

impl Matcher {
    pub fn is_inverse(&self) -> bool {
        matches!(
            self.kind,
            Kind::InverseExact | Kind::InversePrefix | Kind::InverseSuffix
        )
    }

    pub fn search(&self, text: &[u16], scratch: &mut Scratch) -> BitapOutput {
        let hit = |indices: Vec<(i32, i32)>| BitapOutput {
            is_match: true,
            score: 0.0,
            indices,
            has_inverse: false,
        };
        let miss = BitapOutput {
            is_match: false,
            score: 1.0,
            indices: Vec::new(),
            has_inverse: false,
        };
        match self.kind {
            Kind::Exact => {
                if text == self.pattern.as_slice() {
                    hit(vec![(0, self.pattern.len() as i32 - 1)])
                } else {
                    miss
                }
            }
            Kind::Include => {
                if self.pattern.is_empty() {
                    return miss;
                }
                let mut indices = Vec::new();
                let mut from = 0usize;
                while let Some(index) = index_of(text, &self.pattern, from) {
                    let end = index + self.pattern.len();
                    indices.push((index as i32, end as i32 - 1));
                    from = end;
                    if self.pattern.is_empty() {
                        break;
                    }
                }
                if indices.is_empty() {
                    miss
                } else {
                    hit(indices)
                }
            }
            Kind::Prefix => {
                if text.starts_with(&self.pattern) {
                    hit(vec![(0, self.pattern.len() as i32 - 1)])
                } else {
                    miss
                }
            }
            Kind::InversePrefix => {
                if !text.starts_with(&self.pattern) {
                    hit(vec![(0, text.len() as i32 - 1)])
                } else {
                    miss
                }
            }
            Kind::InverseSuffix => {
                if !text.ends_with(&self.pattern) {
                    hit(vec![(0, text.len() as i32 - 1)])
                } else {
                    miss
                }
            }
            Kind::Suffix => {
                if text.ends_with(&self.pattern) {
                    hit(vec![(
                        text.len() as i32 - self.pattern.len() as i32,
                        text.len() as i32 - 1,
                    )])
                } else {
                    miss
                }
            }
            Kind::InverseExact => {
                if index_of(text, &self.pattern, 0).is_none() {
                    hit(vec![(0, text.len() as i32 - 1)])
                } else {
                    miss
                }
            }
            Kind::Fuzzy => self
                .fuzzy
                .as_ref()
                .expect("fuzzy matcher has a bitap searcher")
                .search_in(text, scratch),
        }
    }
}

pub fn parse_query(pattern: &[u16], params: &BitapParams) -> Vec<Vec<Matcher>> {
    split_or(pattern)
        .into_iter()
        .map(|group| {
            let restored = restore_pipes(&group);
            let trimmed = trim_js(&restored);
            tokenize(trimmed)
                .into_iter()
                .filter(|token| !trim_js(token).is_empty())
                .filter_map(|token| compile_token(token, params))
                .collect()
        })
        .collect()
}

fn compile_token(token: &[u16], params: &BitapParams) -> Option<Matcher> {
    if let Some((kind, inner)) = match_multi(token) {
        return Some(build(kind, inner, params));
    }
    if let Some((kind, inner)) = match_single(token) {
        return Some(build(kind, inner, params));
    }
    None
}

fn build(kind: Kind, inner: &[u16], params: &BitapParams) -> Matcher {
    let fuzzy = if kind == Kind::Fuzzy {
        Some(BitapSearch::new(inner, params.clone()))
    } else {
        None
    };
    Matcher {
        kind,
        pattern: inner.to_vec(),
        fuzzy,
    }
}

fn match_multi(token: &[u16]) -> Option<(Kind, &[u16])> {
    // ="..."  ' "..."  ^"..."  !^"..."  !"..."$  "..."$  !"..."  "..."
    if wrapped(token, b"=\"", b"\"") {
        return Some((Kind::Exact, &token[2..token.len() - 1]));
    }
    if wrapped(token, b"'\"", b"\"") {
        return Some((Kind::Include, &token[2..token.len() - 1]));
    }
    if wrapped(token, b"^\"", b"\"") {
        return Some((Kind::Prefix, &token[2..token.len() - 1]));
    }
    if wrapped(token, b"!^\"", b"\"") {
        return Some((Kind::InversePrefix, &token[3..token.len() - 1]));
    }
    if wrapped(token, b"!\"", b"\"$") {
        return Some((Kind::InverseSuffix, &token[2..token.len() - 2]));
    }
    if wrapped(token, b"\"", b"\"$") {
        return Some((Kind::Suffix, &token[1..token.len() - 2]));
    }
    if wrapped(token, b"!\"", b"\"") {
        return Some((Kind::InverseExact, &token[2..token.len() - 1]));
    }
    if wrapped(token, b"\"", b"\"") {
        return Some((Kind::Fuzzy, &token[1..token.len() - 1]));
    }
    None
}

fn match_single(token: &[u16]) -> Option<(Kind, &[u16])> {
    if starts(token, b"=") {
        return Some((Kind::Exact, &token[1..]));
    }
    if starts(token, b"'") {
        return Some((Kind::Include, &token[1..]));
    }
    if starts(token, b"^") {
        return Some((Kind::Prefix, &token[1..]));
    }
    if starts(token, b"!^") {
        return Some((Kind::InversePrefix, &token[2..]));
    }
    if starts(token, b"!") && ends(token, b"$") {
        return Some((Kind::InverseSuffix, &token[1..token.len() - 1]));
    }
    if ends(token, b"$") {
        return Some((Kind::Suffix, &token[..token.len() - 1]));
    }
    if starts(token, b"!") {
        return Some((Kind::InverseExact, &token[1..]));
    }
    Some((Kind::Fuzzy, token))
}

fn starts(token: &[u16], prefix: &[u8]) -> bool {
    token.len() >= prefix.len()
        && prefix
            .iter()
            .enumerate()
            .all(|(i, b)| token[i] == *b as u16)
}

fn ends(token: &[u16], suffix: &[u8]) -> bool {
    token.len() >= suffix.len()
        && suffix
            .iter()
            .rev()
            .enumerate()
            .all(|(i, b)| token[token.len() - 1 - i] == *b as u16)
}

fn wrapped(token: &[u16], prefix: &[u8], suffix: &[u8]) -> bool {
    token.len() >= prefix.len() + suffix.len() && starts(token, prefix) && ends(token, suffix)
}

fn split_or(pattern: &[u16]) -> Vec<Vec<u16>> {
    let mut escaped = Vec::with_capacity(pattern.len());
    let mut i = 0;
    while i < pattern.len() {
        if pattern[i] == b'\\' as u16 && i + 1 < pattern.len() && pattern[i + 1] == b'|' as u16 {
            escaped.push(0);
            i += 2;
        } else {
            escaped.push(pattern[i]);
            i += 1;
        }
    }
    let mut groups = Vec::new();
    let mut current = Vec::new();
    for unit in escaped {
        if unit == b'|' as u16 {
            groups.push(std::mem::take(&mut current));
        } else {
            current.push(unit);
        }
    }
    groups.push(current);
    groups
}

fn restore_pipes(group: &[u16]) -> Vec<u16> {
    group
        .iter()
        .map(|unit| if *unit == 0 { b'|' as u16 } else { *unit })
        .collect()
}

fn tokenize(pattern: &[u16]) -> Vec<&[u16]> {
    let mut tokens = Vec::new();
    let len = pattern.len();
    let mut i = 0;
    while i < len {
        while i < len && pattern[i] == b' ' as u16 {
            i += 1;
        }
        if i >= len {
            break;
        }
        let mut j = i;
        while j < len && pattern[j] != b' ' as u16 && pattern[j] != b'"' as u16 {
            j += 1;
        }
        if j < len && pattern[j] == b'"' as u16 {
            j += 1;
            while j < len {
                if pattern[j] == b'"' as u16 {
                    let next = j + 1;
                    if next >= len || pattern[next] == b' ' as u16 {
                        j += 1;
                        break;
                    }
                    if pattern[next] == b'$' as u16
                        && (next + 1 >= len || pattern[next + 1] == b' ' as u16)
                    {
                        j += 2;
                        break;
                    }
                }
                j += 1;
            }
            tokens.push(&pattern[i..j]);
            i = j;
        } else {
            while j < len && pattern[j] != b' ' as u16 {
                j += 1;
            }
            tokens.push(&pattern[i..j]);
            i = j;
        }
    }
    tokens
}

fn is_js_trim_whitespace(code: u16) -> bool {
    matches!(
        code,
        0x0009
            | 0x000A
            | 0x000B
            | 0x000C
            | 0x000D
            | 0x0020
            | 0x00A0
            | 0x1680
            | 0x2028
            | 0x2029
            | 0x202F
            | 0x205F
            | 0x3000
            | 0xFEFF
    ) || (0x2000..=0x200A).contains(&code)
}

fn trim_js(text: &[u16]) -> &[u16] {
    let mut start = 0;
    let mut end = text.len();
    while start < end && is_js_trim_whitespace(text[start]) {
        start += 1;
    }
    while end > start && is_js_trim_whitespace(text[end - 1]) {
        end -= 1;
    }
    &text[start..end]
}
