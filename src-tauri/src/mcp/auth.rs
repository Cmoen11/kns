//! Bearer tokens and rate limits for the MCP server (docs/plan-features.md §5.2).
//!
//! - A token is 32 random bytes, base64url without padding (43 characters). Only its SHA-256 is
//!   stored (`rust/mcp.json`); the plain token goes to the clipboard once (`clip.rs`) and is kept
//!   nowhere.
//! - Lookups compare every stored hash in constant time, so timing reveals neither which client
//!   matched nor how much of a hash did.
//! - The client's identity is the token's **name**, never the `clientInfo` an agent sends.
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use base64::Engine;
use rand::Rng;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Requests per second per token, sustained.
pub const RATE_PER_SEC: f64 = 10.0;
/// Burst a token may spend at once.
pub const BURST: f64 = 30.0;
/// Requests of one token being served at the same time.
pub const MAX_IN_FLIGHT: u32 = 4;

/// The identity of an authenticated request (inserted as a request extension by the auth layer).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ClientName(pub String);

/// A new random token: 32 bytes, base64url, no padding.
pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Lowercase hex SHA-256 of a token (what `mcp.json` stores).
pub fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Client names: what the human types in the wizard; also the audit and policy key.
pub fn valid_client_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 40 && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// The value of `Authorization: Bearer <token>`; `None` for anything else.
pub fn bearer(header: Option<&str>) -> Option<&str> {
    let value = header?.trim();
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty() && token.len() <= 256).then_some(token)
}

/// The name of the client whose stored hash matches `token`. Every entry is compared, in
/// constant time per entry.
pub fn find_client<'a>(clients: impl IntoIterator<Item = (&'a str, &'a str)>, token: &str) -> Option<String> {
    let want = hash_token(token);
    let mut found = None;
    for (name, hash) in clients {
        let same: bool = want.as_bytes().ct_eq(hash.as_bytes()).into();
        if same && found.is_none() {
            found = Some(name.to_string());
        }
    }
    found
}

/// Token bucket plus in-flight count, per client.
#[derive(Debug, Default)]
pub struct Limiter {
    buckets: HashMap<String, Bucket>,
}

#[derive(Debug)]
struct Bucket {
    tokens: f64,
    at: Instant,
    in_flight: u32,
}

/// Why a request was refused by the limiter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Limited {
    Rate,
    InFlight,
}

impl Limiter {
    /// Takes one request for `client` at `now`; on success the caller must call `done` when the
    /// request has been answered.
    pub fn acquire(&mut self, client: &str, now: Instant) -> Result<(), Limited> {
        let b = self.buckets.entry(client.to_string()).or_insert(Bucket { tokens: BURST, at: now, in_flight: 0 });
        let elapsed = now.saturating_duration_since(b.at).as_secs_f64();
        b.tokens = (b.tokens + elapsed * RATE_PER_SEC).min(BURST);
        b.at = now;
        if b.in_flight >= MAX_IN_FLIGHT {
            return Err(Limited::InFlight);
        }
        if b.tokens < 1.0 {
            return Err(Limited::Rate);
        }
        b.tokens -= 1.0;
        b.in_flight += 1;
        Ok(())
    }

    pub fn done(&mut self, client: &str) {
        if let Some(b) = self.buckets.get_mut(client) {
            b.in_flight = b.in_flight.saturating_sub(1);
        }
    }

    /// Forgets a client (revoked).
    pub fn forget(&mut self, client: &str) {
        self.buckets.remove(client);
    }

    /// Seconds until the next request would pass the rate check (for `Retry-After`).
    pub fn retry_after(&self, client: &str) -> Duration {
        let need = self.buckets.get(client).map_or(0.0, |b| (1.0 - b.tokens).max(0.0));
        Duration::from_secs_f64((need / RATE_PER_SEC).max(0.1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_random_and_hashed() {
        let a = new_token();
        let b = new_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 43);
        assert!(a.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
        assert_eq!(hash_token(&a).len(), 64);
        assert_eq!(hash_token(&a), hash_token(&a));
        assert_ne!(hash_token(&a), hash_token(&b));
    }

    #[test]
    fn bearer_parsing() {
        assert_eq!(bearer(Some("Bearer abc")), Some("abc"));
        assert_eq!(bearer(Some("bearer  abc ")), Some("abc"));
        assert_eq!(bearer(Some("Basic abc")), None);
        assert_eq!(bearer(Some("Bearer")), None);
        assert_eq!(bearer(Some("Bearer ")), None);
        assert_eq!(bearer(None), None);
        assert_eq!(bearer(Some(&format!("Bearer {}", "x".repeat(300)))), None);
    }

    #[test]
    fn finds_only_matching_clients() {
        let t = new_token();
        let h = hash_token(&t);
        let other = hash_token("nope");
        let clients = [("a", other.as_str()), ("claude-code", h.as_str())];
        assert_eq!(find_client(clients, &t).as_deref(), Some("claude-code"));
        assert_eq!(find_client(clients, "wrong"), None);
        assert_eq!(find_client([], &t), None);
    }

    #[test]
    fn names() {
        assert!(valid_client_name("claude-code"));
        assert!(valid_client_name("a.b_c-1"));
        for bad in ["", "a b", "x/y", "ø", &"a".repeat(41)] {
            assert!(!valid_client_name(bad), "{bad}");
        }
    }

    #[test]
    fn limiter_burst_refill_and_in_flight() {
        let mut l = Limiter::default();
        let t0 = Instant::now();
        // in flight caps at 4
        for _ in 0..MAX_IN_FLIGHT {
            l.acquire("c", t0).unwrap();
        }
        assert_eq!(l.acquire("c", t0), Err(Limited::InFlight));
        for _ in 0..MAX_IN_FLIGHT {
            l.done("c");
        }
        // burst of 30 total, then rate limited
        for _ in 0..(BURST as usize - MAX_IN_FLIGHT as usize) {
            l.acquire("c", t0).unwrap();
            l.done("c");
        }
        assert_eq!(l.acquire("c", t0), Err(Limited::Rate));
        assert!(l.retry_after("c") > Duration::ZERO);
        // other clients are independent
        l.acquire("d", t0).unwrap();
        // 10/s refill
        let t1 = t0 + Duration::from_millis(250);
        l.acquire("c", t1).unwrap();
        l.done("c");
        l.acquire("c", t1).unwrap();
        l.done("c");
        assert_eq!(l.acquire("c", t1), Err(Limited::Rate));
        l.forget("c");
        l.acquire("c", t1).unwrap();
    }
}
