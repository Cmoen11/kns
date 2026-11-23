//! Feature contracts: Rust mirror of `src/ipc/contract/*.ts` (docs/plan-features.md §2.1).
//! One owner per file (see the header of each); re-exported from `crate::ipc`.
//! Every module has a drift test that writes `src/ipc/contract/__fixtures__/<module>.ts` (see `drift`).
pub mod agents;
pub mod debug;
pub mod dev;
pub mod diag;
pub mod diff;
pub mod events;
pub mod fwd;
pub mod health;
pub mod logs;
pub mod pack;
pub mod update;

pub use agents::*;
pub use debug::*;
pub use dev::*;
pub use diag::*;
pub use diff::*;
pub use events::*;
pub use fwd::*;
pub use health::*;
pub use logs::*;
pub use pack::*;
pub use update::*;

#[cfg(test)]
pub(crate) mod drift;
