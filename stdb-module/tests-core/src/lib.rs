//! Host-target test harness for the SpacetimeDB module's pure gameplay logic.
//!
//! `stdb-module` compiles to `wasm32-unknown-unknown` and links against the
//! SpacetimeDB host ABI, so `cargo test` cannot build it natively. The physics
//! and robot-AI code is deliberately free of `spacetimedb` imports, so this
//! crate pulls those two files in by path and runs their test suites.
//!
//! Run with: `npm run test:module` (or `cargo test` from this directory).

#[path = "../../src/sim.rs"]
pub mod sim;

#[path = "../../src/robot.rs"]
pub mod robot;
