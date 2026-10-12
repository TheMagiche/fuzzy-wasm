//! Record-level score, ported from Fuse.js `core/computeScore.ts`.
//!
//! Each matched key contributes
//! `pow(score === 0 && weight ? EPSILON : score, (weight || 1) * norm)`.
//! The record score is the product. A string-list record has no key, so a
//! perfect 0 stays 0. An object key with a 0 score uses `Number.EPSILON` so
//! a perfect hit on a weighted field still outranks a fuzzy one without
//! collapsing the product to 0.

#[derive(Clone, Copy, Debug)]
pub struct ScorePart {
    pub score: f64,
    /// `None` when the match has no key (string collections).
    pub weight: Option<f64>,
    pub norm: f64,
}

pub fn combine_scores(parts: &[ScorePart], ignore_field_norm: bool) -> f64 {
    let mut total = 1.0;
    for part in parts {
        let weight_truthy = matches!(part.weight, Some(w) if w != 0.0);
        let base = if part.score == 0.0 && weight_truthy {
            f64::EPSILON
        } else {
            part.score
        };
        let weight = match part.weight {
            Some(w) if w != 0.0 => w,
            _ => 1.0,
        };
        let norm = if ignore_field_norm { 1.0 } else { part.norm };
        total *= base.powf(weight * norm);
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn string_list_perfect_is_zero() {
        let score = combine_scores(
            &[ScorePart {
                score: 0.0,
                weight: None,
                norm: 1.0,
            }],
            false,
        );
        assert_eq!(score, 0.0);
    }

    #[test]
    fn weighted_perfect_uses_epsilon() {
        // fuse.js 7.5: include `'Old` on "Old Man's War" (norm 0.577, weight 1).
        let score = combine_scores(
            &[ScorePart {
                score: 0.0,
                weight: Some(1.0),
                norm: 0.577,
            }],
            false,
        );
        assert!((score - 9.287439764962262e-10).abs() < 1e-18);
    }

    #[test]
    fn fuzzy_field_norm_matches_js() {
        // "world" in "hello world": raw 0.06, norm 0.707, no key.
        let score = combine_scores(
            &[ScorePart {
                score: 0.06,
                weight: None,
                norm: 0.707,
            }],
            false,
        );
        assert!((score - 0.13682105473575515).abs() < 1e-15);
    }
}
