//! Detect subscription CLIs and build the command that would run.
//!
//! Codex and Cursor commands are recorded and not executed. Claude is invoked
//! only as a planner, from `usage`.

use crate::procutil::which;

pub const SUBSCRIPTION_NAMES: &[&str] = &["claude", "codex", "cursor"];
const CURSOR_BINARIES: &[&str] = &["cursor-agent", "agent", "cursor"];

#[derive(Debug, Clone)]
pub struct SubscriptionStatus {
    pub name: String,
    pub connected: bool,
    pub binary: String,
    pub detail: String,
}

impl SubscriptionStatus {
    pub fn as_json(&self) -> serde_json::Value {
        serde_json::json!({
            "name": self.name,
            "connected": self.connected,
            "binary": self.binary,
            "detail": self.detail,
        })
    }
}

pub fn binary_names(subscription: &str) -> Vec<String> {
    match subscription {
        "cursor" => CURSOR_BINARIES.iter().map(|s| (*s).to_string()).collect(),
        "claude" | "codex" => vec![subscription.to_string()],
        _ => Vec::new(),
    }
}

pub fn find_binary(subscription: &str) -> String {
    for name in binary_names(subscription) {
        if let Some(found) = which(&name) {
            return found.display().to_string();
        }
    }
    String::new()
}

pub fn inspect_subscription(subscription: &str) -> SubscriptionStatus {
    if subscription.is_empty() {
        return SubscriptionStatus {
            name: String::new(),
            connected: false,
            binary: String::new(),
            detail: "no subscription is configured".into(),
        };
    }
    if !SUBSCRIPTION_NAMES.contains(&subscription) {
        return SubscriptionStatus {
            name: subscription.into(),
            connected: false,
            binary: String::new(),
            detail: format!("{subscription} is not a known subscription"),
        };
    }
    let binary = find_binary(subscription);
    if binary.is_empty() {
        let expected = binary_names(subscription).join(", ");
        return SubscriptionStatus {
            name: subscription.into(),
            connected: false,
            binary: String::new(),
            detail: format!("subscription is not connected ({expected} was not found on PATH)"),
        };
    }
    SubscriptionStatus {
        name: subscription.into(),
        connected: true,
        binary: binary.clone(),
        detail: format!("connected via {binary}"),
    }
}

pub fn contribution_prompt(repo_url: &str, action: &str) -> String {
    let verb = match action {
        "test" => "Test the project",
        "audit" => "Audit the code",
        "issue" => "Open an issue",
        "pull_request" => "Open a pull request",
        _ => "Contribute",
    };
    format!(
        "{verb} for {repo_url}. Repository code, builds, tests, and other repo commands must run only in the IdleHand sandbox. The sandbox has no home directory and no credentials. Do not read or copy credentials. This subscription CLI stays outside that sandbox."
    )
}

pub fn subscription_command(subscription: &str, binary: &str, repo_url: &str, action: &str) -> Vec<String> {
    let prompt = contribution_prompt(repo_url, action);
    let names = binary_names(subscription);
    let executable = if !binary.is_empty() {
        binary.to_string()
    } else if names.is_empty() {
        subscription.to_string()
    } else {
        names[0].clone()
    };
    if subscription == "codex" {
        vec![executable, "exec".into(), prompt]
    } else {
        vec![executable, "-p".into(), prompt]
    }
}
