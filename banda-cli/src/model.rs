use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Identity {
    pub name: String,
    pub role: String,
    pub kind: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Member {
    pub name: String,
    pub kind: String,
    pub room: String,
    pub status: String,
    pub connected: bool,
    pub attention: bool,
    pub reason: Option<String>,
    pub repo: Option<String>,
    pub host: Option<String>,
    pub command: Option<String>,
    pub caps: Vec<String>,
    pub accept: Value,
    #[serde(rename = "runId")]
    pub run_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct RoomMessage {
    pub id: String,
    pub ts: String,
    pub room: String,
    pub kind: String,
    pub text: String,
    pub from: Identity,
    pub to: Option<String>,
    // The JS hub emits null, rather than [], for messages without attachments.
    #[serde(deserialize_with = "null_media")]
    pub media: Vec<Media>,
}

fn null_media<'de, D>(deserializer: D) -> Result<Vec<Media>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<Vec<Media>>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Media {
    pub url: String,
    pub name: String,
    #[serde(rename = "type")]
    pub media_type: String,
    pub size: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Room {
    pub room: String,
    pub agents: u64,
    pub online: u64,
    pub working: u64,
    pub blocked: u64,
    pub attention: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_messages_without_media_and_members_without_runtime_metadata_decode() {
        let message: RoomMessage = serde_json::from_value(json!({
            "id": "message", "text": "hello", "media": null,
            "from": {"name": "Ada", "role": "owner"}
        }))
        .unwrap();
        assert!(message.media.is_empty());
        assert_eq!(message.from.name, "Ada");
        assert_eq!(message.from.kind, "");
        let member: Member = serde_json::from_value(json!({"name": "Ada"})).unwrap();
        assert_eq!(member.run_id, None);
        let member: Member =
            serde_json::from_value(json!({"name": "Ada", "runId": "new-run"})).unwrap();
        assert_eq!(member.run_id.as_deref(), Some("new-run"));
    }
}
