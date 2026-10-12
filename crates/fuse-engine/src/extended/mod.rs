//! Extended search, ported from Fuse.js `src/search/extended`.
//!
//! Space means AND, `|` means OR, and `\|` is a literal pipe. Operators, tried
//! in Fuse's order: `=exact`, `'include`, `^prefix`, `!^inverse-prefix`,
//! `!suffix$` inverse-suffix, `suffix$`, `!inverse`, then fuzzy.

mod matchers;

use crate::bitap::{BitapOutput, BitapParams, Scratch};
use matchers::{parse_query, Matcher};

pub struct ExtendedSearch {
    groups: Vec<Vec<Matcher>>,
    params: BitapParams,
}

impl ExtendedSearch {
    pub fn new(pattern: &[u16], params: BitapParams) -> Self {
        let groups = parse_query(pattern, &params);
        Self { groups, params }
    }

    pub fn search_in(&self, text: &[u16], scratch: &mut Scratch) -> BitapOutput {
        if self.groups.is_empty() {
            return BitapOutput {
                is_match: false,
                score: 1.0,
                indices: Vec::new(),
                has_inverse: false,
            };
        }

        for group in &self.groups {
            let mut num_matches = 0usize;
            let mut total_score = 0.0;
            let mut has_inverse = false;
            let mut all_indices = Vec::new();
            let mut failed = false;

            for matcher in group {
                let result = matcher.search(text, scratch);
                if result.is_match {
                    num_matches += 1;
                    total_score += result.score;
                    if matcher.is_inverse() {
                        has_inverse = true;
                    }
                    if self.params.include_matches {
                        all_indices.extend(result.indices);
                    }
                } else {
                    failed = true;
                    break;
                }
            }

            if !failed && num_matches > 0 {
                let mut out = BitapOutput {
                    is_match: true,
                    score: total_score / num_matches as f64,
                    indices: Vec::new(),
                    has_inverse,
                };
                if self.params.include_matches {
                    out.indices = crate::bitap::merge_indices(all_indices);
                }
                return out;
            }
        }

        BitapOutput {
            is_match: false,
            score: 1.0,
            indices: Vec::new(),
            has_inverse: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    fn run(text: &str, pattern: &str) -> BitapOutput {
        let search = ExtendedSearch::new(
            &units(pattern),
            BitapParams {
                include_matches: true,
                ..BitapParams::default()
            },
        );
        let mut scratch = Scratch::default();
        search.search_in(&units(text), &mut scratch)
    }

    #[test]
    fn operators() {
        let exact = run("hello", "=hello");
        assert!(exact.is_match && exact.score == 0.0);
        assert!(!run("hello", "=hell").is_match);

        let include = run("hello world", "'world");
        assert!(include.is_match);
        assert_eq!(include.indices, vec![(6, 10)]);

        assert!(run("hello", "^hell").is_match);
        assert!(!run("hello", "^ello").is_match);
        assert!(run("hello", "llo$").is_match);
        assert!(run("hello", "!xyz").is_match);
        assert!(!run("hello", "!hell").is_match);
        assert!(run("hello", "!^xyz").is_match);
        assert!(!run("hello", "!^hell").is_match);
        assert!(run("hello", "!xyz$").is_match);
        assert!(!run("hello", "!llo$").is_match);
    }

    #[test]
    fn and_or_and_escaped_pipe() {
        let and = run("the old man and the sea", "^the sea$");
        assert!(and.is_match);
        assert_eq!(and.indices, vec![(0, 2), (20, 22)]);

        let or = run("young", "old | young");
        assert!(or.is_match);

        let escaped = run("a|b", "'a\\|b");
        assert!(escaped.is_match);
        assert_eq!(escaped.indices, vec![(0, 2)]);
    }

    #[test]
    fn quoted_include() {
        let out = run("hello world today", "'\"hello world\"");
        assert!(out.is_match);
        assert_eq!(out.indices, vec![(0, 10)]);
    }
}
