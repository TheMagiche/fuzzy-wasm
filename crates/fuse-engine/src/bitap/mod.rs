//! Bitap approximate matching, ported from Fuse.js `src/search/bitap`.
//!
//! Patterns longer than 32 code units are split into 32-unit chunks. The last
//! partial chunk overlaps the end of the pattern (`start = len - 32`) and the
//! chunk scores are averaged. Text is a slice of UTF-16 code units so indices
//! match JavaScript strings, including emoji.

mod alphabet;
mod matched;
mod score;

use alphabet::Alphabet;
use matched::convert_mask_to_indices;
use score::{compute_score, ScoreInput};

pub use matched::merge_indices;

pub const MAX_BITS: usize = 32;

#[derive(Clone, Debug)]
pub struct BitapParams {
    pub location: i64,
    pub distance: f64,
    pub threshold: f64,
    pub find_all_matches: bool,
    pub min_match_char_length: usize,
    pub include_matches: bool,
    pub ignore_location: bool,
}

impl Default for BitapParams {
    fn default() -> Self {
        Self {
            location: 0,
            distance: 100.0,
            threshold: 0.6,
            find_all_matches: false,
            min_match_char_length: 1,
            include_matches: false,
            ignore_location: false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BitapOutput {
    pub is_match: bool,
    pub score: f64,
    pub indices: Vec<(i32, i32)>,
    pub has_inverse: bool,
}

impl BitapOutput {
    fn miss() -> Self {
        Self {
            is_match: false,
            score: 1.0,
            indices: Vec::new(),
            has_inverse: false,
        }
    }
}

/// Buffers reused across every record in one query. Bitap otherwise allocates
/// a bit array per error level per record.
#[derive(Default)]
pub struct Scratch {
    bit_arr: Vec<u32>,
    last_bit_arr: Vec<u32>,
    match_mask: Vec<u8>,
}

struct Chunk {
    pattern: Vec<u16>,
    alphabet: Alphabet,
    start_index: i64,
}

pub struct BitapSearch {
    pattern: Vec<u16>,
    chunks: Vec<Chunk>,
    params: BitapParams,
}

impl BitapSearch {
    pub fn new(pattern: &[u16], params: BitapParams) -> Self {
        let mut chunks = Vec::new();
        if !pattern.is_empty() {
            let add = |chunks: &mut Vec<Chunk>, start: usize, len: usize| {
                let slice = pattern[start..start + len].to_vec();
                let alphabet = Alphabet::from_pattern(&slice);
                chunks.push(Chunk {
                    pattern: slice,
                    alphabet,
                    start_index: start as i64,
                });
            };
            let len = pattern.len();
            if len > MAX_BITS {
                let remainder = len % MAX_BITS;
                let end = len - remainder;
                let mut i = 0;
                while i < end {
                    add(&mut chunks, i, MAX_BITS);
                    i += MAX_BITS;
                }
                if remainder > 0 {
                    add(&mut chunks, len - MAX_BITS, MAX_BITS);
                }
            } else {
                add(&mut chunks, 0, len);
            }
        }
        Self {
            pattern: pattern.to_vec(),
            chunks,
            params,
        }
    }

    pub fn search_in(&self, text: &[u16], scratch: &mut Scratch) -> BitapOutput {
        let params = &self.params;

        if self.pattern == text {
            if text.len() < params.min_match_char_length {
                return BitapOutput::miss();
            }
            let mut out = BitapOutput {
                is_match: true,
                score: 0.0,
                indices: Vec::new(),
                has_inverse: false,
            };
            if params.include_matches {
                let end = if text.is_empty() {
                    -1
                } else {
                    text.len() as i32 - 1
                };
                out.indices.push((0, end));
            }
            return out;
        }

        // Exact character-absence filter. A chunk cannot score at or under
        // `threshold` when too many of its code units never appear in `text`,
        // because each absence costs at least one error and
        // `score >= errors / patternLen`. Skipping is allowed only when every
        // chunk is impossible: a single surviving chunk still needs the real
        // per-chunk scores (failed chunks are averaged in).
        if self.all_chunks_impossible(text) {
            return BitapOutput::miss();
        }

        let mut all_indices = Vec::new();
        let mut total_score = 0.0;
        let mut has_matches = false;

        for chunk in &self.chunks {
            let mut chunk_params = params.clone();
            chunk_params.location = params.location + chunk.start_index;
            let result = search_chunk(
                text,
                &chunk.pattern,
                &chunk.alphabet,
                &chunk_params,
                scratch,
            );
            if result.is_match {
                has_matches = true;
            }
            total_score += result.score;
            if result.is_match && params.include_matches {
                all_indices.extend(result.indices);
            }
        }

        let mut out = BitapOutput {
            is_match: has_matches,
            score: if has_matches {
                total_score / self.chunks.len() as f64
            } else {
                1.0
            },
            indices: Vec::new(),
            has_inverse: false,
        };
        if has_matches && params.include_matches {
            out.indices = merge_indices(all_indices);
        }
        out
    }

    fn all_chunks_impossible(&self, text: &[u16]) -> bool {
        if self.chunks.is_empty() {
            return false;
        }
        let bits = ascii_bits(text);
        self.chunks.iter().all(|chunk| {
            let missing = missing_ascii(&chunk.pattern, &bits);
            if missing == 0 {
                return false;
            }
            let min_score = missing as f64 / chunk.pattern.len() as f64;
            min_score > self.params.threshold
        })
    }
}

fn ascii_bits(text: &[u16]) -> [u64; 4] {
    let mut bits = [0u64; 4];
    for &c in text {
        if c < 256 {
            let c = c as usize;
            bits[c >> 6] |= 1u64 << (c & 63);
        }
    }
    bits
}

fn missing_ascii(pattern: &[u16], bits: &[u64; 4]) -> usize {
    let mut missing = 0;
    for &c in pattern {
        if c < 256 {
            let cu = c as usize;
            let present = (bits[cu >> 6] >> (cu & 63)) & 1;
            if present == 0 {
                missing += 1;
            }
        }
    }
    missing
}

/// UTF-16 `String.prototype.indexOf`.
pub fn index_of(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(from.min(haystack.len()));
    }
    if from > haystack.len() || needle.len() > haystack.len().saturating_sub(from) {
        return None;
    }
    let start = from;
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        if let Some(pos) = simd_index_of(&haystack[start..], needle) {
            return Some(pos + start);
        }
        return None;
    }
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    {
        haystack[start..]
            .windows(needle.len())
            .position(|window| window == needle)
            .map(|pos| pos + start)
    }
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
fn simd_index_of(haystack: &[u16], needle: &[u16]) -> Option<usize> {
    // SIMD `indexOf` for the Bitap exact-hit pass and include-match.
    // Benchmarks on long fields show the vector scan dominates; the scalar
    // confirm keeps it exact. `v128_load` requires 16-byte alignment, so the
    // eight code units are copied into an aligned local first.
    use std::arch::wasm32::{u16x8_bitmask, u16x8_eq, u16x8_splat, v128_load};
    #[repr(align(16))]
    struct Lane([u16; 8]);

    let first = needle[0];
    let n = needle.len();
    let mut i = 0;
    if haystack.len() >= n && haystack.len() - n + 1 >= 8 {
        let last = haystack.len() - n + 1;
        let needle_v = u16x8_splat(first);
        while i + 8 <= last {
            let mut lane = Lane([0; 8]);
            lane.0.copy_from_slice(&haystack[i..i + 8]);
            // SAFETY: `lane` is align(16) and holds exactly 8 u16s (one v128).
            let v = unsafe { v128_load(lane.0.as_ptr().cast()) };
            let bits = u16x8_bitmask(u16x8_eq(v, needle_v));
            if bits != 0 {
                for offset in 0..8 {
                    if bits & (1 << offset) != 0 {
                        let at = i + offset;
                        if haystack[at..at + n] == needle[..] {
                            return Some(at);
                        }
                    }
                }
            }
            i += 8;
        }
    }
    haystack[i..]
        .windows(n)
        .position(|window| window == needle)
        .map(|pos| pos + i)
}

fn search_chunk(
    text: &[u16],
    pattern: &[u16],
    alphabet: &Alphabet,
    params: &BitapParams,
    scratch: &mut Scratch,
) -> BitapOutput {
    if pattern.is_empty() || pattern.len() > MAX_BITS {
        return BitapOutput::miss();
    }

    let pattern_len = pattern.len() as i64;
    let text_len = text.len() as i64;
    let expected = params.location.clamp(0, text_len);
    let mut current_threshold = params.threshold;
    let compute_matches = params.min_match_char_length > 1 || params.include_matches;

    if compute_matches {
        scratch.match_mask.clear();
        scratch.match_mask.resize(text.len(), 0);
    }

    let calc = |errors: f64, current_location: f64| {
        compute_score(ScoreInput {
            errors,
            current_location,
            expected_location: expected as f64,
            distance: params.distance,
            ignore_location: params.ignore_location,
            pattern_len: pattern_len as f64,
        })
    };

    // Exact indexOf pass. This both tightens the threshold and, when matches
    // are recorded, paints every exact hit onto the mask. Fuse resets the
    // cursor afterwards; the best *fuzzy* location starts unknown.
    let mut cursor = expected;
    while let Some(index) = index_of(text, pattern, cursor.max(0) as usize) {
        let score = calc(0.0, index as f64);
        current_threshold = current_threshold.min(score);
        cursor = index as i64 + pattern_len;
        if compute_matches {
            for offset in 0..pattern.len() {
                scratch.match_mask[index + offset] = 1;
            }
        }
        if cursor > text_len {
            break;
        }
    }

    scratch.last_bit_arr.clear();
    let mut final_score = 1.0;
    let mut best_location: i64 = -1;
    let mut best_errors: i64 = 0;
    let mut bin_max = pattern_len + text_len;
    let mask = 1u32 << (pattern_len as u32 - 1);

    for i in 0..pattern_len {
        let mut bin_min = 0i64;
        let mut bin_mid = bin_max;
        while bin_min < bin_mid {
            let score = calc(i as f64, (expected + bin_mid) as f64);
            if score <= current_threshold {
                bin_min = bin_mid;
            } else {
                bin_max = bin_mid;
            }
            bin_mid = (bin_max - bin_min) / 2 + bin_min;
        }
        bin_max = bin_mid;

        let mut start = 1.max(expected - bin_mid + 1);
        let finish = if params.find_all_matches {
            text_len
        } else {
            (expected + bin_mid).min(text_len) + pattern_len
        };

        let arr_len = (finish + 2) as usize;
        scratch.bit_arr.clear();
        scratch.bit_arr.resize(arr_len, 0);
        scratch.bit_arr[finish as usize + 1] = (1u32 << (i as u32)) - 1;

        let mut j = finish;
        while j >= start {
            let current_location = j - 1;
            let char_match = if current_location >= 0 && (current_location as usize) < text.len() {
                alphabet.get(text[current_location as usize])
            } else {
                0
            };

            let next = scratch.bit_arr[(j + 1) as usize];
            scratch.bit_arr[j as usize] = ((next << 1) | 1) & char_match;

            if i > 0 {
                let at = |idx: i64| -> u32 {
                    if idx >= 0 && (idx as usize) < scratch.last_bit_arr.len() {
                        scratch.last_bit_arr[idx as usize]
                    } else {
                        0
                    }
                };
                let lj1 = at(j + 1);
                let lj = at(j);
                scratch.bit_arr[j as usize] |= ((lj1 | lj) << 1) | 1 | lj1;
            }

            if scratch.bit_arr[j as usize] & mask != 0 {
                final_score = calc(i as f64, current_location as f64);
                if final_score <= current_threshold {
                    current_threshold = final_score;
                    best_location = current_location;
                    best_errors = i;
                    if best_location <= expected {
                        break;
                    }
                    start = 1.max(2 * expected - best_location);
                }
            }
            j -= 1;
        }

        let next_score = calc((i + 1) as f64, expected as f64);
        if next_score > current_threshold {
            break;
        }
        std::mem::swap(&mut scratch.bit_arr, &mut scratch.last_bit_arr);
    }

    if compute_matches && best_location >= 0 {
        let match_end = (text_len - 1).min(best_location + pattern_len - 1 + best_errors);
        let mut k = best_location;
        while k <= match_end {
            if k >= 0 && (k as usize) < text.len() && alphabet.get(text[k as usize]) != 0 {
                scratch.match_mask[k as usize] = 1;
            }
            k += 1;
        }
    }

    let mut out = BitapOutput {
        is_match: best_location >= 0,
        score: final_score.max(0.001),
        indices: Vec::new(),
        has_inverse: false,
    };

    if compute_matches {
        let indices = convert_mask_to_indices(&scratch.match_mask, params.min_match_char_length);
        if indices.is_empty() {
            out.is_match = false;
        } else if params.include_matches {
            out.indices = indices;
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    fn search(text: &str, pattern: &str, params: BitapParams) -> BitapOutput {
        let engine = BitapSearch::new(&units(pattern), params);
        let mut scratch = Scratch::default();
        engine.search_in(&units(text), &mut scratch)
    }

    fn with_matches() -> BitapParams {
        BitapParams {
            include_matches: true,
            ..BitapParams::default()
        }
    }

    #[test]
    fn exact_string_scores_zero() {
        let out = search("hello", "hello", with_matches());
        assert!(out.is_match);
        assert_eq!(out.score, 0.0);
        assert_eq!(out.indices, vec![(0, 4)]);
    }

    #[test]
    fn one_substitution() {
        let out = search("hello", "hallo", with_matches());
        assert!(out.is_match);
        assert!((out.score - 0.2).abs() < 1e-12);
        assert_eq!(out.indices, vec![(0, 0), (2, 4)]);
    }

    #[test]
    fn location_penalty() {
        let out = search("hello world", "world", with_matches());
        assert!(out.is_match);
        assert!((out.score - 0.06).abs() < 1e-12);
        assert_eq!(out.indices, vec![(6, 10)]);
    }

    #[test]
    fn ignore_location_zero_errors_floors_at_one_thousandth() {
        let out = search(
            "hello world",
            "world",
            BitapParams {
                include_matches: true,
                ignore_location: true,
                ..BitapParams::default()
            },
        );
        assert!((out.score - 0.001).abs() < 1e-15);
    }

    #[test]
    fn emoji_is_two_code_units() {
        let out = search("😀😀", "😀", with_matches());
        assert!(out.is_match);
        assert_eq!(out.indices, vec![(0, 3)]);
        assert!((out.score - 0.001).abs() < 1e-15);
    }

    #[test]
    fn long_pattern_chunks() {
        // Fuse lowercases before Bitap. `EXTRA` → `extra`, so x/t/r sit in the
        // second chunk's alphabet and become their own range; `e` does not.
        let pattern = "abcdefghijklmnopqrstuvwxyz0123456789zzzz";
        let text = "abcdefghijklmnopqrstuvwxyz0123456789extra";
        assert!(pattern.encode_utf16().count() > MAX_BITS);
        let out = search(
            text,
            pattern,
            BitapParams {
                include_matches: true,
                threshold: 0.4,
                ..BitapParams::default()
            },
        );
        assert!(out.is_match);
        assert!((out.score - 0.063).abs() < 1e-12);
        assert_eq!(out.indices, vec![(0, 35), (37, 39)]);
    }

    #[test]
    fn min_match_char_length_rejects() {
        let out = search(
            "ab",
            "ab",
            BitapParams {
                include_matches: true,
                min_match_char_length: 3,
                ..BitapParams::default()
            },
        );
        assert!(!out.is_match);
    }

    #[test]
    fn absent_characters_do_not_match() {
        let out = search("zzzz", "abcd", BitapParams::default());
        assert!(!out.is_match);
        assert_eq!(out.score, 1.0);
    }

    #[test]
    fn empty_query_does_not_match_text() {
        let out = search("abc", "", BitapParams::default());
        assert!(!out.is_match);
    }
}
