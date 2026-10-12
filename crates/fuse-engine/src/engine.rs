//! In-memory index and search. Records live here for the life of the engine;
//! a query crosses the boundary once and comes back as a flat hit list.

use crate::bitap::{BitapOutput, BitapParams, BitapSearch, Scratch};
use crate::buf::Reader;
use crate::extended::ExtendedSearch;
use crate::logical::{decode_query, QueryNode};
use crate::results::{encode_hits, sort_hits, Hit, MaxHeap, OutMatch};
use crate::scoring::{combine_scores, ScorePart};

const MAGIC: u32 = 0x4655_5345;

#[derive(Clone, Debug)]
pub struct Options {
    pub threshold: f64,
    pub distance: f64,
    pub location: i64,
    pub include_matches: bool,
    pub find_all_matches: bool,
    pub min_match_char_length: usize,
    pub ignore_location: bool,
    pub ignore_field_norm: bool,
    pub use_extended_search: bool,
    pub should_sort: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            threshold: 0.6,
            distance: 100.0,
            location: 0,
            include_matches: false,
            find_all_matches: false,
            min_match_char_length: 1,
            ignore_location: false,
            ignore_field_norm: false,
            use_extended_search: false,
            should_sort: true,
        }
    }
}

#[derive(Clone, Debug)]
struct FieldValue {
    text: Vec<u16>,
    norm: f64,
    array_index: i32,
}

#[derive(Clone, Debug)]
struct Record {
    idx: u32,
    /// String collections. Empty for object collections.
    text: Vec<u16>,
    norm: f64,
    /// One entry per key, in key order. Empty for string collections.
    fields: Vec<Vec<FieldValue>>,
}

enum Searcher {
    Bitap(BitapSearch),
    Extended(ExtendedSearch),
}

impl Searcher {
    fn search_in(&self, text: &[u16], scratch: &mut Scratch) -> BitapOutput {
        match self {
            Searcher::Bitap(search) => search.search_in(text, scratch),
            Searcher::Extended(search) => search.search_in(text, scratch),
        }
    }
}

pub struct Engine {
    opts: Options,
    weights: Vec<f64>,
    records: Vec<Record>,
    string_list: bool,
    scratch: Scratch,
}

impl Engine {
    pub fn new(opts: Options) -> Self {
        Self {
            opts,
            weights: Vec::new(),
            records: Vec::new(),
            string_list: false,
            scratch: Scratch::default(),
        }
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn set_records(&mut self, data: &[u8]) -> Result<(), String> {
        let mut reader = Reader::new(data);
        let magic = reader.u32()?;
        if magic != MAGIC {
            return Err(format!("bad record blob magic {magic:#x}"));
        }
        self.string_list = reader.u8()? != 0;
        let key_count = reader.u32()? as usize;
        self.weights = Vec::with_capacity(key_count);
        for _ in 0..key_count {
            self.weights.push(reader.f64()?);
        }
        let record_count = reader.u32()? as usize;
        self.records = Vec::with_capacity(record_count);
        for _ in 0..record_count {
            self.records
                .push(read_record(&mut reader, self.string_list, key_count)?);
        }
        if reader.remaining() != 0 {
            return Err("trailing bytes in record blob".into());
        }
        Ok(())
    }

    pub fn add_record(&mut self, data: &[u8]) -> Result<(), String> {
        let mut reader = Reader::new(data);
        let record = read_record(&mut reader, self.string_list, self.weights.len())?;
        if reader.remaining() != 0 {
            return Err("trailing bytes in added record".into());
        }
        self.records.push(record);
        Ok(())
    }

    /// Drop records whose source index is in `indices`, then shift survivors
    /// down by how many removed indices sit strictly below them.
    pub fn remove_indices(&mut self, indices: &[u32]) {
        if indices.is_empty() {
            return;
        }
        let mut sorted: Vec<u32> = indices.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        self.records
            .retain(|record| sorted.binary_search(&record.idx).is_err());
        for record in &mut self.records {
            let shift = sorted.partition_point(|idx| *idx < record.idx) as u32;
            record.idx -= shift;
        }
    }

    pub fn search(&mut self, query: &[u16], limit: i32, default_sort: bool) -> Vec<u8> {
        let searcher = self.compile(query);
        let hits = if self.string_list {
            self.collect_strings(&searcher, limit, default_sort)
        } else {
            self.collect_objects(&searcher, limit, default_sort)
        };
        let detailed = !default_sort;
        encode_hits(&hits, self.opts.include_matches, detailed)
    }

    pub fn search_logical(
        &mut self,
        query: &[u8],
        limit: i32,
        default_sort: bool,
    ) -> Result<Vec<u8>, String> {
        // Fuse's logical path reads `record.$`. String records have no `$`,
        // so a logical query over a string list matches nothing.
        if self.string_list {
            return Ok(encode_hits(&[], self.opts.include_matches, !default_sort));
        }
        let tree = decode_query(query)?;
        let mut compiled = Vec::new();
        let root = compile_tree(tree, &self.opts, &mut compiled)?;
        let mut hits = Vec::new();
        for record in &self.records {
            let mut matches = Vec::new();
            if !eval_node(
                &root,
                &compiled,
                record,
                &self.weights,
                &mut self.scratch,
                &mut matches,
            ) {
                continue;
            }
            if matches.is_empty() {
                continue;
            }
            let score = score_matches(&matches, &self.weights, self.opts.ignore_field_norm);
            hits.push(Hit {
                idx: record.idx,
                score,
                matches,
            });
        }
        let detailed = !default_sort;
        if default_sort && self.opts.should_sort {
            sort_hits(&mut hits);
        }
        let hits = if default_sort {
            apply_limit(hits, limit)
        } else {
            hits
        };
        Ok(encode_hits(&hits, self.opts.include_matches, detailed))
    }

    fn compile(&self, query: &[u16]) -> Searcher {
        let params = self.params();
        if self.opts.use_extended_search {
            Searcher::Extended(ExtendedSearch::new(query, params))
        } else {
            Searcher::Bitap(BitapSearch::new(query, params))
        }
    }

    fn params(&self) -> BitapParams {
        BitapParams {
            location: self.opts.location,
            distance: self.opts.distance,
            threshold: self.opts.threshold,
            find_all_matches: self.opts.find_all_matches,
            min_match_char_length: self.opts.min_match_char_length,
            include_matches: self.opts.include_matches,
            ignore_location: self.opts.ignore_location,
        }
    }

    fn collect_strings(&mut self, searcher: &Searcher, limit: i32, default_sort: bool) -> Vec<Hit> {
        let use_heap = default_sort && self.opts.should_sort && limit > 0;
        let mut heap = MaxHeap::new(if use_heap { limit as usize } else { 0 });
        let mut hits = Vec::new();
        for record in &self.records {
            let result = searcher.search_in(&record.text, &mut self.scratch);
            if !result.is_match {
                continue;
            }
            let matches = vec![OutMatch {
                key_index: -1,
                array_index: -1,
                raw_score: result.score,
                norm: record.norm,
                indices: result.indices,
            }];
            let score = score_matches(&matches, &self.weights, self.opts.ignore_field_norm);
            let hit = Hit {
                idx: record.idx,
                score,
                matches,
            };
            if use_heap {
                heap.insert(hit);
            } else {
                hits.push(hit);
            }
        }
        finish_hits(
            hits,
            heap,
            use_heap,
            default_sort,
            self.opts.should_sort,
            limit,
        )
    }

    fn collect_objects(&mut self, searcher: &Searcher, limit: i32, default_sort: bool) -> Vec<Hit> {
        let use_heap = default_sort && self.opts.should_sort && limit > 0;
        let mut heap = MaxHeap::new(if use_heap { limit as usize } else { 0 });
        let mut hits = Vec::new();
        for record in &self.records {
            let mut matches = Vec::new();
            let mut any_failed = false;
            let mut has_inverse = false;
            for (key_index, values) in record.fields.iter().enumerate() {
                let mut key_matches = Vec::new();
                for value in values {
                    let result = searcher.search_in(&value.text, &mut self.scratch);
                    if result.is_match {
                        key_matches.push(OutMatch {
                            key_index: key_index as i32,
                            array_index: value.array_index,
                            raw_score: result.score,
                            norm: value.norm,
                            indices: result.indices,
                            // has_inverse is read off the first match below.
                        });
                        if key_matches.len() == 1 && result.has_inverse {
                            has_inverse = true;
                        }
                    }
                }
                if key_matches.is_empty() {
                    any_failed = true;
                } else {
                    matches.extend(key_matches);
                }
            }
            if has_inverse && any_failed {
                continue;
            }
            if matches.is_empty() {
                continue;
            }
            let score = score_matches(&matches, &self.weights, self.opts.ignore_field_norm);
            let hit = Hit {
                idx: record.idx,
                score,
                matches,
            };
            if use_heap {
                heap.insert(hit);
            } else {
                hits.push(hit);
            }
        }
        finish_hits(
            hits,
            heap,
            use_heap,
            default_sort,
            self.opts.should_sort,
            limit,
        )
    }
}

fn finish_hits(
    mut hits: Vec<Hit>,
    heap: MaxHeap,
    use_heap: bool,
    default_sort: bool,
    should_sort: bool,
    limit: i32,
) -> Vec<Hit> {
    if !default_sort {
        return hits;
    }
    if use_heap {
        return heap.into_sorted();
    }
    if should_sort {
        sort_hits(&mut hits);
    }
    apply_limit(hits, limit)
}

fn apply_limit(mut hits: Vec<Hit>, limit: i32) -> Vec<Hit> {
    if limit >= 0 {
        let limit = limit as usize;
        if hits.len() > limit {
            hits.truncate(limit);
        }
    }
    hits
}

fn score_matches(matches: &[OutMatch], weights: &[f64], ignore_field_norm: bool) -> f64 {
    let parts: Vec<ScorePart> = matches
        .iter()
        .map(|m| ScorePart {
            score: m.raw_score,
            weight: if m.key_index >= 0 {
                weights.get(m.key_index as usize).copied()
            } else {
                None
            },
            norm: m.norm,
        })
        .collect();
    combine_scores(&parts, ignore_field_norm)
}

fn read_record(
    reader: &mut Reader<'_>,
    string_list: bool,
    key_count: usize,
) -> Result<Record, String> {
    let idx = reader.u32()?;
    if string_list {
        let norm = reader.f64()?;
        let text = reader.utf16()?;
        return Ok(Record {
            idx,
            text,
            norm,
            fields: Vec::new(),
        });
    }
    let mut fields = Vec::with_capacity(key_count);
    for _ in 0..key_count {
        let value_count = reader.u32()? as usize;
        let mut values = Vec::with_capacity(value_count);
        for _ in 0..value_count {
            values.push(FieldValue {
                array_index: reader.i32()?,
                norm: reader.f64()?,
                text: reader.utf16()?,
            });
        }
        fields.push(values);
    }
    Ok(Record {
        idx,
        text: Vec::new(),
        norm: 1.0,
        fields,
    })
}

struct CompiledLeaf {
    key_index: i32,
    searcher: Searcher,
}

enum CompiledNode {
    Leaf(usize),
    And(Vec<CompiledNode>),
    Or(Vec<CompiledNode>),
}

fn compile_tree(
    node: QueryNode,
    opts: &Options,
    leaves: &mut Vec<CompiledLeaf>,
) -> Result<CompiledNode, String> {
    match node {
        QueryNode::Leaf { key_index, pattern } => {
            let params = BitapParams {
                location: opts.location,
                distance: opts.distance,
                threshold: opts.threshold,
                find_all_matches: opts.find_all_matches,
                min_match_char_length: opts.min_match_char_length,
                include_matches: opts.include_matches,
                ignore_location: opts.ignore_location,
            };
            let searcher = if opts.use_extended_search {
                Searcher::Extended(ExtendedSearch::new(&pattern, params))
            } else {
                Searcher::Bitap(BitapSearch::new(&pattern, params))
            };
            let index = leaves.len();
            leaves.push(CompiledLeaf {
                key_index,
                searcher,
            });
            Ok(CompiledNode::Leaf(index))
        }
        QueryNode::And(children) => {
            Ok(CompiledNode::And(compile_children(children, opts, leaves)?))
        }
        QueryNode::Or(children) => Ok(CompiledNode::Or(compile_children(children, opts, leaves)?)),
    }
}

fn compile_children(
    children: Vec<QueryNode>,
    opts: &Options,
    leaves: &mut Vec<CompiledLeaf>,
) -> Result<Vec<CompiledNode>, String> {
    let mut out = Vec::with_capacity(children.len());
    for child in children {
        out.push(compile_tree(child, opts, leaves)?);
    }
    Ok(out)
}

/// Returns false when an AND child failed. Matches are appended in Fuse's order.
fn eval_node(
    node: &CompiledNode,
    leaves: &[CompiledLeaf],
    record: &Record,
    weights: &[f64],
    scratch: &mut Scratch,
    out: &mut Vec<OutMatch>,
) -> bool {
    match node {
        CompiledNode::And(children) => {
            let start = out.len();
            for child in children {
                let before = out.len();
                let ok = eval_node(child, leaves, record, weights, scratch, out);
                if !ok || out.len() == before {
                    out.truncate(start);
                    return false;
                }
            }
            !children.is_empty()
        }
        CompiledNode::Or(children) => {
            let before = out.len();
            for child in children {
                let _ = eval_node(child, leaves, record, weights, scratch, out);
            }
            out.len() > before
        }
        CompiledNode::Leaf(index) => {
            let leaf = &leaves[*index];
            let start = out.len();
            if leaf.key_index < -1 {
                return false;
            }
            if leaf.key_index == -1 {
                for (key_index, values) in record.fields.iter().enumerate() {
                    push_key_matches(&leaf.searcher, key_index as i32, values, scratch, out);
                }
            } else if (leaf.key_index as usize) < record.fields.len() {
                push_key_matches(
                    &leaf.searcher,
                    leaf.key_index,
                    &record.fields[leaf.key_index as usize],
                    scratch,
                    out,
                );
            }
            let _ = weights;
            out.len() > start
        }
    }
}

fn push_key_matches(
    searcher: &Searcher,
    key_index: i32,
    values: &[FieldValue],
    scratch: &mut Scratch,
    out: &mut Vec<OutMatch>,
) {
    for value in values {
        let result = searcher.search_in(&value.text, scratch);
        if result.is_match {
            out.push(OutMatch {
                key_index,
                array_index: value.array_index,
                raw_score: result.score,
                norm: value.norm,
                indices: result.indices,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    struct Blob {
        buf: Vec<u8>,
    }

    impl Blob {
        fn new() -> Self {
            Self { buf: Vec::new() }
        }
        fn u8(&mut self, v: u8) {
            self.buf.push(v);
        }
        fn u32(&mut self, v: u32) {
            self.buf.extend_from_slice(&v.to_le_bytes());
        }
        fn i32(&mut self, v: i32) {
            self.buf.extend_from_slice(&v.to_le_bytes());
        }
        fn f64(&mut self, v: f64) {
            self.buf.extend_from_slice(&v.to_le_bytes());
        }
        fn utf16(&mut self, text: &str) {
            let encoded: Vec<u16> = text.encode_utf16().collect();
            self.u32(encoded.len() as u32);
            for unit in encoded {
                self.buf.extend_from_slice(&unit.to_le_bytes());
            }
        }
    }

    fn decode_score_idx(buf: &[u8]) -> Vec<(u32, f64)> {
        let mut reader = Reader::new(buf);
        let count = reader.u32().unwrap();
        let mut out = Vec::new();
        for _ in 0..count {
            let idx = reader.u32().unwrap();
            let score = reader.f64().unwrap();
            let matches = reader.u32().unwrap();
            for _ in 0..matches {
                let _key = reader.i32().unwrap();
                let _arr = reader.i32().unwrap();
                let pairs = reader.u32().unwrap();
                for _ in 0..pairs {
                    let _s = reader.i32().unwrap();
                    let _e = reader.i32().unwrap();
                }
            }
            out.push((idx, score));
        }
        out
    }

    #[test]
    fn string_list_matches_fuse_scores() {
        let mut blob = Blob::new();
        blob.u32(MAGIC);
        blob.u8(1);
        blob.u32(0);
        blob.u32(2);
        blob.u32(0);
        blob.f64(1.0);
        blob.utf16("hello");
        blob.u32(1);
        blob.f64(0.707);
        blob.utf16("hello world");

        let mut engine = Engine::new(Options {
            include_matches: true,
            ..Options::default()
        });
        engine.set_records(&blob.buf).unwrap();
        let hello = decode_score_idx(&engine.search(&units("hello"), -1, true));
        assert_eq!(hello[0], (0, 0.0));
        assert_eq!(hello[1].0, 1);
        assert!(hello[1].1 > 0.0);

        let world = decode_score_idx(&engine.search(&units("world"), -1, true));
        assert_eq!(world[0].0, 1);
        assert!((world[0].1 - 0.13682105473575515).abs() < 1e-12);
    }

    #[test]
    fn weighted_books_match_fuse() {
        // Lowercased, norms taken from fuse.js 7.5. Weights already normalized.
        let mut blob = Blob::new();
        blob.u32(MAGIC);
        blob.u8(0);
        blob.u32(2);
        blob.f64(0.7);
        blob.f64(0.3);
        blob.u32(3);
        for (idx, title, norm, first) in [
            (0u32, "the old man and the sea", 0.408, "ernest"),
            (1, "old man's war", 0.577, "john"),
            (2, "the young man", 0.577, "ernest"),
        ] {
            blob.u32(idx);
            blob.u32(1);
            blob.i32(-1);
            blob.f64(norm);
            blob.utf16(title);
            blob.u32(1);
            blob.i32(-1);
            blob.f64(1.0);
            blob.utf16(first);
        }
        let mut engine = Engine::new(Options {
            include_matches: true,
            threshold: 0.4,
            ..Options::default()
        });
        engine.set_records(&blob.buf).unwrap();
        let hits = decode_score_idx(&engine.search(&units("old man"), -1, true));
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].0, 1);
        assert!((hits[0].1 - 0.061418612340630244).abs() < 1e-12);
        assert_eq!(hits[1].0, 0);
        assert!((hits[1].1 - 0.39879374100758036).abs() < 1e-12);
    }

    #[test]
    fn limit_keeps_fuse_order() {
        let mut blob = Blob::new();
        blob.u32(MAGIC);
        blob.u8(1);
        blob.u32(0);
        blob.u32(6);
        for (i, text) in ["aa", "ab", "ac", "ba", "bb", "zz"].iter().enumerate() {
            blob.u32(i as u32);
            blob.f64(1.0);
            blob.utf16(text);
        }
        let mut engine = Engine::new(Options::default());
        engine.set_records(&blob.buf).unwrap();
        let hits = decode_score_idx(&engine.search(&units("a"), 2, true));
        assert_eq!(hits.len(), 2);
        assert!(hits[0].1 <= hits[1].1);
    }

    #[test]
    fn remove_shifts_indices() {
        let mut blob = Blob::new();
        blob.u32(MAGIC);
        blob.u8(1);
        blob.u32(0);
        blob.u32(3);
        for (i, text) in ["a", "b", "c"].iter().enumerate() {
            blob.u32(i as u32);
            blob.f64(1.0);
            blob.utf16(text);
        }
        let mut engine = Engine::new(Options::default());
        engine.set_records(&blob.buf).unwrap();
        engine.remove_indices(&[1]);
        let hits = decode_score_idx(&engine.search(&units("c"), -1, true));
        assert_eq!(hits, vec![(1, 0.0)]);
    }
}
