//! IdleHand runs a local node that spends leftover subscription credits on open source.

pub const VERSION: &str = "0.1.0";

pub mod actions;
pub mod analytics;
pub mod cli;
pub mod config;
pub mod configure;
pub mod engine;
pub mod fetch;
pub mod forge;
pub mod github;
pub mod handler;
pub mod home;
pub mod jail;
pub mod links;
pub mod node;
pub mod peers;
pub mod process;
pub mod procutil;
pub mod publish;
pub mod radicle;
pub mod sandbox;
pub mod subscriptions;
pub mod trust;
pub mod usage;
