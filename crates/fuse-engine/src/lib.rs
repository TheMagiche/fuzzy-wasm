//! Fuse.js-compatible search engine.
//!
//! Text stored here is already normalized the way Fuse normalizes it at
//! compare time (JavaScript `toLowerCase`, then diacritic stripping). The
//! host keeps the original strings for `value` and `toJSON`. Match indices
//! are UTF-16 code-unit offsets into the normalized text, which is what
//! Fuse reports.

mod bitap;
mod buf;
mod engine;
mod extended;
mod logical;
mod norm;
mod normalize;
mod results;
mod scoring;

pub use engine::{Engine, Options};
pub use norm::{field_norm, word_count};
pub use normalize::strip_diacritics;

/// True when this binary was compiled with `+simd128`.
pub fn simd_compiled() -> bool {
    cfg!(all(target_arch = "wasm32", target_feature = "simd128"))
}

#[cfg(target_arch = "wasm32")]
mod wasm_api {
    use super::{simd_compiled, Engine, Options};
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub struct FuseEngine {
        inner: Engine,
    }

    #[wasm_bindgen]
    impl FuseEngine {
        #[wasm_bindgen(constructor)]
        pub fn new(
            threshold: f64,
            distance: f64,
            location: f64,
            include_matches: bool,
            find_all_matches: bool,
            min_match_char_length: u32,
            ignore_location: bool,
            ignore_field_norm: bool,
            use_extended_search: bool,
            should_sort: bool,
        ) -> FuseEngine {
            FuseEngine {
                inner: Engine::new(Options {
                    threshold,
                    distance,
                    // Fuse feeds `location` through `Math.min`/`Math.max`. Non-integers
                    // are truncated toward zero, matching `ToInteger` for the index walk.
                    location: location.trunc() as i64,
                    include_matches,
                    find_all_matches,
                    min_match_char_length: min_match_char_length as usize,
                    ignore_location,
                    ignore_field_norm,
                    use_extended_search,
                    should_sort,
                }),
            }
        }

        pub fn set_records(&mut self, data: &[u8]) -> Result<(), JsValue> {
            self.inner
                .set_records(data)
                .map_err(|err| JsValue::from_str(&err))
        }

        pub fn add_record(&mut self, data: &[u8]) -> Result<(), JsValue> {
            self.inner
                .add_record(data)
                .map_err(|err| JsValue::from_str(&err))
        }

        pub fn remove_indices(&mut self, indices: &[u32]) {
            self.inner.remove_indices(indices);
        }

        /// `query` is UTF-16 code units (`charCodeAt` order), not UTF-8.
        /// `default_sort` is false when the caller supplied a custom `sortFn`.
        /// Hits then come back in scan order so JS can sort and apply `limit`.
        pub fn search(&mut self, query: &[u16], limit: i32, default_sort: bool) -> Vec<u8> {
            self.inner.search(query, limit, default_sort)
        }

        pub fn search_logical(
            &mut self,
            query: &[u8],
            limit: i32,
            default_sort: bool,
        ) -> Result<Vec<u8>, JsValue> {
            self.inner
                .search_logical(query, limit, default_sort)
                .map_err(|err| JsValue::from_str(&err))
        }

        pub fn len(&self) -> u32 {
            self.inner.len() as u32
        }
    }

    #[wasm_bindgen]
    pub fn simd_enabled() -> bool {
        simd_compiled()
    }
}
