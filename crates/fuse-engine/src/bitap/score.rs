//! `computeScore` from Fuse.js `src/search/bitap/computeScore.ts`.
//!
//! `accuracy + proximity / distance`, in f64. `ignoreLocation` drops the
//! proximity term. A zero `distance` dodges a divide-by-zero the same way
//! Fuse does: a miss on location scores 1, an on-location miss scores accuracy.

#[derive(Clone, Copy, Debug)]
pub struct ScoreInput {
    pub errors: f64,
    pub current_location: f64,
    pub expected_location: f64,
    pub distance: f64,
    pub ignore_location: bool,
    pub pattern_len: f64,
}

#[inline]
pub fn compute_score(input: ScoreInput) -> f64 {
    let accuracy = input.errors / input.pattern_len;
    if input.ignore_location {
        return accuracy;
    }
    let proximity = (input.expected_location - input.current_location).abs();
    if input.distance == 0.0 {
        return if proximity != 0.0 { 1.0 } else { accuracy };
    }
    accuracy + proximity / input.distance
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_cases() {
        let base = ScoreInput {
            errors: 0.0,
            current_location: 0.0,
            expected_location: 0.0,
            distance: 100.0,
            ignore_location: false,
            pattern_len: 5.0,
        };
        assert_eq!(compute_score(base), 0.0);
        assert_eq!(
            compute_score(ScoreInput {
                errors: 1.0,
                ..base
            }),
            0.2
        );
        assert_eq!(
            compute_score(ScoreInput {
                current_location: 6.0,
                ..base
            }),
            0.06
        );
        assert_eq!(
            compute_score(ScoreInput {
                ignore_location: true,
                errors: 1.0,
                current_location: 50.0,
                ..base
            }),
            0.2
        );
        assert_eq!(
            compute_score(ScoreInput {
                distance: 0.0,
                current_location: 3.0,
                ..base
            }),
            1.0
        );
        assert_eq!(
            compute_score(ScoreInput {
                distance: 0.0,
                ..base
            }),
            0.0
        );
    }
}
