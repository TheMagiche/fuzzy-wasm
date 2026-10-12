//! `convertMaskToIndices` and `mergeIndices` from Fuse.js.
//!
//! A run of matched code units becomes `[start, end]` inclusive, and runs
//! shorter than `minMatchCharLength` are dropped. Adjacent or overlapping
//! ranges from chunked patterns collapse into one.

pub fn convert_mask_to_indices(mask: &[u8], min_match_char_length: usize) -> Vec<(i32, i32)> {
    let mut indices = Vec::new();
    let mut start: i32 = -1;
    let mut i = 0usize;
    let len = mask.len();
    while i < len {
        let matched = mask[i] != 0;
        if matched && start == -1 {
            start = i as i32;
        } else if !matched && start != -1 {
            let end = i as i32 - 1;
            if (end - start + 1) as usize >= min_match_char_length {
                indices.push((start, end));
            }
            start = -1;
        }
        i += 1;
    }
    if i > 0 && mask[i - 1] != 0 && (i as i32 - start) as usize >= min_match_char_length {
        indices.push((start, i as i32 - 1));
    }
    indices
}

pub fn merge_indices(mut indices: Vec<(i32, i32)>) -> Vec<(i32, i32)> {
    if indices.len() <= 1 {
        return indices;
    }
    indices.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut merged = Vec::with_capacity(indices.len());
    merged.push(indices[0]);
    for curr in indices.into_iter().skip(1) {
        let last = merged.last_mut().expect("merged is non-empty");
        if curr.0 <= last.1 + 1 {
            last.1 = last.1.max(curr.1);
        } else {
            merged.push(curr);
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_and_drops_short_runs() {
        let mask = [1, 0, 1, 1, 1, 0, 1];
        assert_eq!(
            convert_mask_to_indices(&mask, 1),
            vec![(0, 0), (2, 4), (6, 6)]
        );
        assert_eq!(convert_mask_to_indices(&mask, 3), vec![(2, 4)]);
        assert!(convert_mask_to_indices(&[], 1).is_empty());
    }

    #[test]
    fn merges_adjacent_ranges() {
        let merged = merge_indices(vec![(4, 6), (0, 2), (3, 3)]);
        assert_eq!(merged, vec![(0, 6)]);
    }
}
