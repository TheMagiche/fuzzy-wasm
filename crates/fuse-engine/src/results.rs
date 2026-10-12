//! Flat result buffer.
//!
//! ```text
//! u32 count
//! repeated:
//!   u32 refIndex
//!   f64 score
//!   u32 matchCount
//!   repeated match:
//!     i32 keyIndex      (-1 when the collection is a string list)
//!     i32 arrayIndex    (-1 when the value is not an array element)
//!     [detailed only] f64 rawScore, f64 norm
//!     u32 pairCount
//!     repeated: i32 start, i32 end
//! ```
//!
//! `detailed` is set for a custom `sortFn`, which Fuse invokes with the
//! per-key scores. The common path omits those floats. Indices are present
//! only when `includeMatches` is on; otherwise `pairCount` is 0.

use crate::buf::Writer;

#[derive(Clone, Debug)]
pub struct OutMatch {
    pub key_index: i32,
    pub array_index: i32,
    pub raw_score: f64,
    pub norm: f64,
    pub indices: Vec<(i32, i32)>,
}

#[derive(Clone, Debug)]
pub struct Hit {
    pub idx: u32,
    pub score: f64,
    pub matches: Vec<OutMatch>,
}

pub fn encode_hits(hits: &[Hit], include_matches: bool, detailed: bool) -> Vec<u8> {
    let mut writer = Writer::with_capacity(hits.len().saturating_mul(16) + 4);
    writer.u32(hits.len() as u32);
    for hit in hits {
        writer.u32(hit.idx);
        writer.f64(hit.score);
        if !include_matches && !detailed {
            writer.u32(0);
            continue;
        }
        writer.u32(hit.matches.len() as u32);
        for m in &hit.matches {
            writer.i32(m.key_index);
            writer.i32(m.array_index);
            if detailed {
                writer.f64(m.raw_score);
                writer.f64(m.norm);
            }
            if include_matches {
                writer.u32(m.indices.len() as u32);
                for (start, end) in &m.indices {
                    writer.i32(*start);
                    writer.i32(*end);
                }
            } else {
                writer.u32(0);
            }
        }
    }
    writer.into_vec()
}

/// Max-heap ordered by Fuse's comparator, so the worst of the top-k sits at
/// the root. `extract_sorted` then matches a full sort followed by `slice`.
pub struct MaxHeap {
    limit: usize,
    heap: Vec<Hit>,
}

impl MaxHeap {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            heap: Vec::with_capacity(limit),
        }
    }

    pub fn insert(&mut self, item: Hit) {
        if self.heap.len() < self.limit {
            self.heap.push(item);
            self.bubble_up(self.heap.len() - 1);
        } else if cmp_hit(&item, &self.heap[0]) < 0 {
            self.heap[0] = item;
            self.sink_down(0);
        }
    }

    pub fn into_sorted(mut self) -> Vec<Hit> {
        self.heap.sort_by(|a, b| match cmp_hit(a, b) {
            order if order < 0 => std::cmp::Ordering::Less,
            order if order > 0 => std::cmp::Ordering::Greater,
            _ => std::cmp::Ordering::Equal,
        });
        self.heap
    }

    fn bubble_up(&mut self, mut i: usize) {
        while i > 0 {
            let parent = (i - 1) >> 1;
            if cmp_hit(&self.heap[i], &self.heap[parent]) <= 0 {
                break;
            }
            self.heap.swap(i, parent);
            i = parent;
        }
    }

    fn sink_down(&mut self, mut i: usize) {
        let len = self.heap.len();
        loop {
            let mut largest = i;
            let left = 2 * i + 1;
            let right = 2 * i + 2;
            if left < len && cmp_hit(&self.heap[left], &self.heap[largest]) > 0 {
                largest = left;
            }
            if right < len && cmp_hit(&self.heap[right], &self.heap[largest]) > 0 {
                largest = right;
            }
            if largest == i {
                break;
            }
            self.heap.swap(i, largest);
            i = largest;
        }
    }
}

/// Fuse default `sortFn`: lower score first, then lower `refIndex`.
pub fn cmp_hit(a: &Hit, b: &Hit) -> i32 {
    if a.score == b.score {
        if a.idx < b.idx {
            -1
        } else {
            1
        }
    } else if a.score < b.score {
        -1
    } else {
        1
    }
}

pub fn sort_hits(hits: &mut [Hit]) {
    hits.sort_by(|a, b| match cmp_hit(a, b) {
        order if order < 0 => std::cmp::Ordering::Less,
        order if order > 0 => std::cmp::Ordering::Greater,
        _ => std::cmp::Ordering::Equal,
    });
}
