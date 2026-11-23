//! Auto-update: mirror of `src/ipc/contract/update.ts` (docs/auto-update.md). Produced by
//! `crate::update`.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateState {
    /// this build does not update itself (dev build, no update key, or KNS_NO_UPDATE)
    #[default]
    Disabled,
    Idle,
    Checking,
    Downloading,
    /// downloaded and verified; installs on `update_install`
    Ready,
    Installing,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub state: UpdateState,
    /// the running version
    pub current: String,
    /// the newer version on offer (downloading, ready, installing)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// release notes of that version, as published
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// percent downloaded, when the size is known
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    /// why the state is `disabled` or `error`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// RFC 3339 time of the last finished check
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::drift::Fixtures;

    #[test]
    fn drift() {
        let mut f = Fixtures::new("update");
        let base = UpdateStatus { current: "0.2.0".into(), ..Default::default() };
        f.add(
            "statuses",
            "UpdateStatus[]",
            &vec![
                UpdateStatus { message: Some("development build".into()), ..base.clone() },
                UpdateStatus { state: UpdateState::Idle, checked_at: Some("2026-11-23T10:00:00Z".into()), ..base.clone() },
                UpdateStatus { state: UpdateState::Checking, ..base.clone() },
                UpdateStatus { state: UpdateState::Downloading, version: Some("0.3.0".into()), progress: Some(42), ..base.clone() },
                UpdateStatus { state: UpdateState::Ready, version: Some("0.3.0".into()), notes: Some("- faster tables".into()), checked_at: Some("2026-11-23T10:00:00Z".into()), ..base.clone() },
                UpdateStatus { state: UpdateState::Installing, version: Some("0.3.0".into()), ..base.clone() },
                UpdateStatus { state: UpdateState::Error, message: Some("network unreachable".into()), ..base },
            ],
        );
        f.check();
    }
}
