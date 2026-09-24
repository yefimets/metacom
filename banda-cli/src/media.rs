use crate::config::{self, Config};
use crate::model::Media;
use anyhow::{Context, Result, anyhow, ensure};
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::{Client, Response, Url};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncReadExt;

const MAX_BYTES: u64 = 20 * 1024 * 1024;
const MAX_ITEMS: usize = 8;
const MAX_UPLOAD_REPLY: u64 = 64 * 1024;

pub async fn upload(config: &Config, paths: &[PathBuf]) -> Result<Vec<Media>> {
    ensure!(
        paths.len() <= MAX_ITEMS,
        "At most {MAX_ITEMS} attachments can be sent in a message"
    );
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let token = config.owner_token()?;
    let origin = http_origin(&config.url)?;
    let endpoint = origin.join("media")?;
    let client = http_client()?;
    let mut uploaded = Vec::with_capacity(paths.len());
    for path in paths {
        uploaded.push(
            upload_one(&client, &origin, &endpoint, token, path)
                .await
                .with_context(|| format!("Upload of {} failed", path.display()))?,
        );
    }
    Ok(uploaded)
}

async fn upload_one(
    client: &Client,
    origin: &Url,
    endpoint: &Url,
    token: &str,
    path: &Path,
) -> Result<Media> {
    let media_type = upload_type(path).ok_or_else(|| {
        anyhow!(
            "Only PNG, JPEG, GIF, WebP, HEIC, SVG, PDF, plain text and Markdown files are supported"
        )
    })?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("Attachment must have a Unicode filename"))?;
    let file = tokio::fs::File::open(path)
        .await
        .context("cannot open attachment")?;
    let metadata = file.metadata().await.context("cannot inspect attachment")?;
    ensure!(metadata.is_file(), "Attachment must be a regular file");
    validate_size(metadata.len())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .context("cannot read attachment")?;
    validate_size(bytes.len() as u64)?;
    let actual_size = bytes.len() as u64;
    let response = client
        .post(endpoint.clone())
        .bearer_auth(token)
        .header(CONTENT_TYPE, media_type)
        .header("X-Name", encode_name(name))
        .body(bytes)
        .send()
        .await
        .map_err(http_error)?;
    ensure_success(&response)?;
    let body = bounded_body(response, MAX_UPLOAD_REPLY).await?;
    let media: Media = serde_json::from_slice(&body)
        .map_err(|_| anyhow!("Hub returned invalid attachment metadata"))?;
    validate_media(origin, &media)?;
    ensure!(
        media.media_type == media_type && media.size == actual_size,
        "Hub returned inconsistent attachment metadata"
    );
    Ok(media)
}

pub async fn download(config: &Config, items: &[Media]) -> Result<Vec<PathBuf>> {
    ensure!(
        items.len() <= MAX_ITEMS,
        "At most {MAX_ITEMS} attachments are allowed in a message"
    );
    if items.is_empty() {
        return Ok(Vec::new());
    }
    let origin = http_origin(&config.url)?;
    // Validate the entire batch before performing any network or filesystem work.
    let urls = items
        .iter()
        .map(|item| {
            validate_media(&origin, item)
                .with_context(|| format!("Invalid attachment {:?}", item.name))
        })
        .collect::<Result<Vec<_>>>()?;
    let client = http_client()?;
    let directory = cache_directory(&origin)?;
    let mut downloaded = Vec::with_capacity(items.len());
    for (item, url) in items.iter().zip(urls) {
        downloaded.push(
            download_one(&client, config, item, url, &directory)
                .await
                .with_context(|| format!("Download of attachment {:?} failed", item.name))?,
        );
    }
    Ok(downloaded)
}

async fn download_one(
    client: &Client,
    config: &Config,
    item: &Media,
    url: Url,
    directory: &Path,
) -> Result<PathBuf> {
    let name = media_filename(url.path()).ok_or_else(|| anyhow!("Invalid attachment path"))?;
    let path = directory.join(name);
    match tokio::fs::symlink_metadata(&path).await {
        Ok(metadata) => {
            ensure!(
                metadata.is_file() && !metadata.file_type().is_symlink(),
                "Attachment cache entry is not a regular file"
            );
            if metadata.len() == item.size {
                #[cfg(unix)]
                tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).await?;
                return Ok(path);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("cannot inspect attachment cache"),
    }
    let mut request = client.get(url);
    // Current hubs serve random media capabilities without authentication. If a
    // private proxy requires a token, never send the owner's credential for an agent.
    if let Ok(token) = config.agent_token() {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(http_error)?;
    ensure_success(&response)?;
    let response_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .ok_or_else(|| anyhow!("Hub omitted attachment Content-Type"))?;
    ensure!(
        response_type.eq_ignore_ascii_case(&item.media_type),
        "Attachment Content-Type does not match its metadata"
    );
    let bytes = bounded_body(response, MAX_BYTES).await?;
    validate_size(bytes.len() as u64)?;
    ensure!(
        bytes.len() as u64 == item.size,
        "Attachment size does not match its metadata"
    );
    let saved_path = path.clone();
    tokio::task::spawn_blocking(move || config::atomic_private_write(&saved_path, &bytes))
        .await
        .context("attachment cache writer failed")??;
    Ok(path)
}

fn http_client() -> Result<Client> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(120))
        .user_agent(concat!("banda/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(http_error)
}

fn http_origin(raw: &str) -> Result<Url> {
    let mut url = config::websocket_url(raw)?;
    let scheme = if url.scheme() == "wss" {
        "https"
    } else {
        "http"
    };
    url.set_scheme(scheme)
        .map_err(|_| anyhow!("Invalid hub HTTP scheme"))?;
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn validate_media(origin: &Url, item: &Media) -> Result<Url> {
    validate_size(item.size)
        .with_context(|| format!("Invalid size for attachment {:?}", item.name))?;
    let url = if item.url.starts_with("/media/") {
        // Checking before parsing also rejects encoded separators and dot segments.
        ensure!(
            media_filename(&item.url).is_some(),
            "Invalid attachment path"
        );
        origin
            .join(&item.url)
            .map_err(|_| anyhow!("Invalid attachment URL"))?
    } else {
        Url::parse(&item.url)
            .map_err(|_| anyhow!("Attachment URL must be an absolute hub URL or /media path"))?
    };
    ensure!(
        url.origin() == origin.origin(),
        "Attachment URL is not at the configured hub origin"
    );
    ensure!(
        url.username().is_empty() && url.password().is_none(),
        "Attachment URL must not contain credentials"
    );
    ensure!(
        url.query().is_none() && url.fragment().is_none(),
        "Attachment URL must not contain a query or fragment"
    );
    let file = media_filename(url.path()).ok_or_else(|| {
        anyhow!("Attachment URL must be a /media/<32-hex-id>.<supported-extension> path")
    })?;
    let extension = file
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or_default();
    let expected =
        type_for_extension(extension).ok_or_else(|| anyhow!("Unsupported attachment type"))?;
    ensure!(
        item.media_type == expected,
        "Attachment type does not match its media path"
    );
    Ok(url)
}

fn media_filename(path: &str) -> Option<&str> {
    let file = path.strip_prefix("/media/")?;
    let (id, extension) = file.split_once('.')?;
    if id.len() != 32
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    // The hub canonicalizes JPEG to .jpg and does not serve .jpeg capability URLs.
    if extension == "jpeg" || type_for_extension(extension).is_none() {
        return None;
    }
    Some(file)
}

fn upload_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?;
    type_for_extension(&extension.to_ascii_lowercase())
}

fn type_for_extension(extension: &str) -> Option<&'static str> {
    match extension {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "heic" => Some("image/heic"),
        "svg" => Some("image/svg+xml"),
        "pdf" => Some("application/pdf"),
        "txt" => Some("text/plain"),
        "md" => Some("text/markdown"),
        _ => None,
    }
}

fn validate_size(size: u64) -> Result<()> {
    ensure!(size > 0, "Empty attachments cannot be sent");
    ensure!(size <= MAX_BYTES, "Attachment exceeds the 20 MiB limit");
    Ok(())
}

async fn bounded_body(mut response: Response, limit: u64) -> Result<Vec<u8>> {
    let length = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if let Some(length) = length {
        ensure!(
            length <= limit,
            "HTTP response exceeds the attachment size limit"
        );
    }
    let mut bytes = Vec::with_capacity(length.unwrap_or(0) as usize);
    while let Some(chunk) = response.chunk().await.map_err(http_error)? {
        ensure!(
            chunk.len() as u64 <= limit.saturating_sub(bytes.len() as u64),
            "HTTP response exceeds the attachment size limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn ensure_success(response: &Response) -> Result<()> {
    ensure!(
        response.status().is_success(),
        "Hub media request failed (HTTP {})",
        response.status()
    );
    Ok(())
}

fn http_error(error: reqwest::Error) -> anyhow::Error {
    if error.is_timeout() {
        anyhow!("Hub media request timed out")
    } else if error.is_connect() {
        anyhow!("Cannot connect to hub media endpoint")
    } else if error.is_body() || error.is_decode() {
        anyhow!("Cannot read hub media response")
    } else {
        // reqwest errors may include capability URLs; do not expose them in logs.
        anyhow!("Hub media HTTP request failed")
    }
}

fn cache_directory(origin: &Url) -> Result<PathBuf> {
    let mut path = config::state_dir()?;
    // Separate origins even if two private hubs happen to reuse the same media id.
    let host = origin
        .host_str()
        .ok_or_else(|| anyhow!("Hub URL has no host"))?;
    let host = encode_name(host);
    let port = origin
        .port_or_known_default()
        .ok_or_else(|| anyhow!("Hub URL has no port"))?
        .to_string();
    ensure!(host != "." && host != "..", "Invalid hub hostname");
    for part in ["media", origin.scheme(), host.as_str(), port.as_str()] {
        path.push(part);
        config::ensure_private_dir(&path)?;
    }
    Ok(path)
}

fn encode_name(name: &str) -> String {
    // encodeURIComponent-compatible UTF-8 bytes, not application/x-www-form-urlencoded.
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(name.len());
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[(byte >> 4) as usize]));
            encoded.push(char::from(HEX[(byte & 15) as usize]));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attachment(url: String) -> Media {
        Media {
            url,
            name: "file.png".into(),
            media_type: "image/png".into(),
            size: 12,
        }
    }

    #[test]
    fn only_hub_origin_and_canonical_media_paths_are_accepted() {
        let origin = http_origin("wss://hub.example:9443/socket").unwrap();
        let path = format!("/media/{}.png", "a".repeat(32));
        assert_eq!(
            validate_media(&origin, &attachment(path.clone()))
                .unwrap()
                .as_str(),
            format!("https://hub.example:9443{path}")
        );
        assert!(
            validate_media(
                &origin,
                &attachment(format!("https://hub.example:9443{path}"))
            )
            .is_ok()
        );
        for bad in [
            format!("https://other.example:9443{path}"),
            format!("http://hub.example:9443{path}"),
            format!("https://hub.example{path}"),
            format!("https://user:secret@hub.example:9443{path}"),
            format!("{path}?token=secret"),
            format!("{path}#fragment"),
            format!("//other.example{path}"),
            "/media/../config.json".into(),
            "/media/%2e%2e/config.json".into(),
            format!("/media/{}.png/extra", "a".repeat(32)),
            format!("/media/{}.exe", "a".repeat(32)),
        ] {
            assert!(
                validate_media(&origin, &attachment(bad.clone())).is_err(),
                "accepted {bad}"
            );
        }
    }

    #[test]
    fn metadata_must_match_supported_type_and_bounded_size() {
        let origin = http_origin("ws://localhost/").unwrap();
        let mut media = attachment(format!("/media/{}.png", "0".repeat(32)));
        media.media_type = "text/html".into();
        assert!(validate_media(&origin, &media).is_err());
        media.media_type = "image/png".into();
        media.size = 0;
        assert!(validate_media(&origin, &media).is_err());
        media.size = MAX_BYTES + 1;
        assert!(validate_media(&origin, &media).is_err());
        media.size = MAX_BYTES;
        assert!(validate_media(&origin, &media).is_ok());
    }

    async fn respond(listener: &tokio::net::TcpListener, response: &[u8]) {
        use tokio::io::AsyncWriteExt;
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut chunk = [0; 1024];
        while !request.windows(4).any(|part| part == b"\r\n\r\n") {
            let count = stream.read(&mut chunk).await.unwrap();
            assert_ne!(count, 0);
            request.extend_from_slice(&chunk[..count]);
            assert!(request.len() <= 8192);
        }
        stream.write_all(response).await.unwrap();
        stream.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn chunked_response_cannot_bypass_body_limit() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}/", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                respond(&listener, b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n9\r\n123456789\r\n0\r\n\r\n").await;
            });
            let response = http_client().unwrap().get(endpoint).send().await.unwrap();
            assert!(bounded_body(response, 8).await.is_err());
            server.await.unwrap();
        }).await.unwrap();
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("banda-media-test-{}", uuid::Uuid::new_v4()));
            config::ensure_private_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn redirects_never_download_or_cache_the_target() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let path = format!("/media/{}.png", "a".repeat(32));
            let redirect = format!(
                "HTTP/1.1 302 Found\r\nLocation: {origin}/media/{}.png\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "b".repeat(32)
            );
            let server = tokio::spawn(async move {
                respond(&listener, redirect.as_bytes()).await;
                // Were redirects enabled, this valid response would incorrectly
                // turn the original capability into a successful cached download.
                respond(&listener, b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndata").await;
            });
            let directory = TestDirectory::new();
            let config = Config {
                url: origin.clone(), token: None, agent_token: None,
                room: "default".into(), name: "worker".into(), herdr_session: None,
            };
            let item = Media { size: 4, ..attachment(path.clone()) };
            let result = download_one(&http_client().unwrap(), &config, &item,
                Url::parse(&format!("{origin}{path}")).unwrap(), &directory.0).await;
            server.abort();
            assert!(result.is_err());
            assert!(!directory.0.join(media_filename(&path).unwrap()).exists());
        }).await.unwrap();
    }
}
