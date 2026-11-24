//! Planning model only; not proof a timeout stops CPU/SQL work.
use std::time::{Duration, Instant};
pub const GLOBAL: Duration = Duration::from_secs(25);
pub const STAGES_MS: [u64; 8] = [50, 1_000, 3_000, 3_500, 750, 15_000, 500, 1_200];
#[derive(Clone, Copy, Debug)]
pub struct Deadline {
    end: Instant,
}
impl Deadline {
    #[must_use]
    pub fn new(start: Instant) -> Self {
        Self {
            end: start + GLOBAL,
        }
    }
    #[must_use]
    pub fn allowance(self, now: Instant, cap: Duration) -> Option<Duration> {
        self.end
            .checked_duration_since(now)
            .filter(|d| !d.is_zero())
            .map(|d| d.min(cap))
    }
}
