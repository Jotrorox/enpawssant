//! The Lichess account: signing in with OAuth, keeping the token in the
//! system keychain and making authenticated requests with it.
//!
//! Lichess supports the OAuth authorization code flow with PKCE for public
//! clients, so no client secret is needed. Signing in opens lichess.org in the
//! browser with a redirect to a one-shot HTTP listener on 127.0.0.1, which
//! receives the authorization code. The token never reaches the frontend.
//!
//! Besides plain requests, Lichess streams newline-delimited JSON for games,
//! account events and seeks; `stream` reads those line by line until the
//! server closes the connection or the caller stops listening.

use std::net::Ipv4Addr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use reqwest::{RequestBuilder, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::time::timeout;
use url::Url;

const LICHESS: &str = "https://lichess.org";
/// Lichess does not register public clients; the ID is shown on its consent page.
const CLIENT_ID: &str = "enpawssant";
const KEYRING_SERVICE: &str = "com.jotrorox.enpawssant";
const KEYRING_USER: &str = "lichess";
/// How long to wait for the user to approve access in the browser.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
/// Lichess asks clients to wait a minute after being rate limited.
const RATE_LIMIT_PAUSE: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Streams send an empty line every few seconds; silence for this long means
/// the connection is gone.
const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Permissions asked for when signing in: playing games through the Board API
/// and sending, accepting and declining challenges. Reading public data, as
/// the opening explorer does, needs none.
const SCOPES: [&str; 3] = ["board:play", "challenge:read", "challenge:write"];
/// Longest streamed line accepted; game and event lines are a few kB at most.
const MAX_STREAM_LINE: usize = 1024 * 1024;
/// Requests to the callback listener larger than this are rejected.
const MAX_REQUEST_BYTES: usize = 8 * 1024;

/// What the frontend knows about the signed-in account.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    username: String,
    /// Whether the token may play games and handle challenges. Tokens from
    /// before playing was supported may only read.
    can_play: bool,
}

/// The account as stored in the keychain.
#[derive(Clone, Serialize, Deserialize)]
struct Stored {
    username: String,
    token: String,
    /// The scopes the token was granted; missing for tokens without any.
    #[serde(default)]
    scopes: Vec<String>,
}

impl Stored {
    fn account(&self) -> Account {
        Account {
            username: self.username.clone(),
            can_play: SCOPES
                .iter()
                .all(|scope| self.scopes.iter().any(|s| s == scope)),
        }
    }
}

/// Why an authenticated request failed.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RequestError {
    /// No account is signed in, or Lichess no longer accepts its token.
    SignedOut,
    /// Lichess asked us to slow down; requests resume after a minute.
    RateLimited,
    Failed {
        message: String,
    },
}

impl RequestError {
    fn failed(message: impl ToString) -> RequestError {
        RequestError::Failed {
            message: message.to_string(),
        }
    }
}

pub struct Lichess {
    http: reqwest::Client,
    /// Without an overall timeout, for streams that stay open for a whole game.
    stream_http: reqwest::Client,
    /// `None` until the keychain has been read.
    account: Mutex<Option<Option<Stored>>>,
    /// Lichess asks for one request at a time.
    request_lock: tokio::sync::Mutex<()>,
    paused_until: Mutex<Option<Instant>>,
    /// Cancels the sign-in in progress, if any.
    cancel_sign_in: Mutex<Option<oneshot::Sender<()>>>,
}

const USER_AGENT: &str = concat!(
    "EnPawssant/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/Jotrorox/enpawssant)"
);

impl Default for Lichess {
    fn default() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("the HTTP client configuration is valid");
        let stream_http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(REQUEST_TIMEOUT)
            .read_timeout(STREAM_READ_TIMEOUT)
            .build()
            .expect("the HTTP client configuration is valid");
        Lichess {
            http,
            stream_http,
            account: Mutex::new(None),
            request_lock: tokio::sync::Mutex::new(()),
            paused_until: Mutex::new(None),
            cancel_sign_in: Mutex::new(None),
        }
    }
}

impl Lichess {
    /// The signed-in account, if any.
    pub async fn account(&self) -> Option<Account> {
        self.stored().await.map(|stored| stored.account())
    }

    async fn stored(&self) -> Option<Stored> {
        if let Some(account) = self.account.lock().unwrap().clone() {
            return account;
        }
        // Reading the keychain can block, e.g. while macOS asks for permission.
        let loaded = tokio::task::spawn_blocking(load_account)
            .await
            .unwrap_or(None);
        let mut account = self.account.lock().unwrap();
        // A sign-in or sign-out that finished in the meantime wins.
        account.get_or_insert(loaded).clone()
    }

    fn set_account(&self, account: Option<Stored>) {
        *self.account.lock().unwrap() = Some(account);
    }

    /// Signs in through the browser and stores the token. Cancels any sign-in
    /// that is still waiting for the browser.
    pub async fn sign_in(&self) -> Result<Account, String> {
        let (cancel_tx, cancel_rx) = oneshot::channel();
        if let Some(previous) = self.cancel_sign_in.lock().unwrap().replace(cancel_tx) {
            let _ = previous.send(());
        }

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| format!("could not listen for the Lichess redirect: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let redirect_uri = format!("http://127.0.0.1:{port}/callback");
        let verifier = random_token()?;
        let state = random_token()?;

        let mut authorize = Url::parse(&format!("{LICHESS}/oauth")).expect("valid URL");
        authorize
            .query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", CLIENT_ID)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("code_challenge_method", "S256")
            .append_pair("code_challenge", &code_challenge(&verifier))
            .append_pair("scope", &SCOPES.join(" "))
            .append_pair("state", &state);
        open::that_detached(authorize.as_str())
            .map_err(|e| format!("could not open the browser: {e}"))?;

        let code = tokio::select! {
            code = timeout(SIGN_IN_TIMEOUT, receive_code(&listener, &state)) => {
                code.map_err(|_| "Lichess sign-in timed out".to_owned())??
            }
            _ = cancel_rx => return Err("Lichess sign-in was cancelled".to_owned()),
        };
        drop(listener);

        let token = self.exchange_code(&code, &verifier, &redirect_uri).await?;
        let username = self.fetch_username(&token).await?;
        let previous = self.stored().await;
        // Lichess grants every scope on its consent page or none at all.
        let stored = Stored {
            username,
            token,
            scopes: SCOPES.iter().map(|scope| scope.to_string()).collect(),
        };
        let saved = stored.clone();
        tokio::task::spawn_blocking(move || save_account(&saved))
            .await
            .map_err(|e| e.to_string())??;
        self.set_account(Some(stored.clone()));
        // Signing in again (e.g. to allow playing) replaces the old token, which is of no
        // further use.
        if let Some(previous) = previous.filter(|previous| previous.token != stored.token) {
            self.revoke(&previous.token).await;
        }
        Ok(stored.account())
    }

    /// Revokes a token, on a best-effort basis.
    async fn revoke(&self, token: &str) {
        let _ = self
            .http
            .delete(format!("{LICHESS}/api/token"))
            .bearer_auth(token)
            .send()
            .await;
    }

    /// Stops waiting for the browser.
    pub fn cancel_sign_in(&self) {
        if let Some(cancel) = self.cancel_sign_in.lock().unwrap().take() {
            let _ = cancel.send(());
        }
    }

    /// Forgets the account and revokes its token.
    pub async fn sign_out(&self) -> Result<(), String> {
        let stored = self.stored().await;
        self.set_account(None);
        tokio::task::spawn_blocking(delete_account)
            .await
            .map_err(|e| e.to_string())??;
        if let Some(stored) = stored {
            // Best effort: the token is gone from this machine either way.
            self.revoke(&stored.token).await;
        }
        Ok(())
    }

    /// Sends an authenticated GET request and parses the JSON response.
    pub async fn get_json<T: DeserializeOwned>(
        &self,
        url: &str,
        query: &[(&str, String)],
    ) -> Result<T, RequestError> {
        let stored = self.stored().await.ok_or(RequestError::SignedOut)?;
        let _turn = self.request_lock.lock().await;
        self.ensure_not_paused()?;

        let response = self
            .http
            .get(url)
            .query(query)
            .bearer_auth(&stored.token)
            .send()
            .await
            .map_err(|e| RequestError::failed(without_url(e)))?;
        self.check(response)
            .await?
            .json()
            .await
            .map_err(|e| RequestError::failed(without_url(e)))
    }

    /// Sends an authenticated request to lichess.org (`path` starts with `/`)
    /// and returns its JSON response, or `null` for an empty or non-JSON one.
    /// Unlike explorer lookups these are the user's own actions, like moves,
    /// so they don't queue behind other requests.
    pub async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        form: &[(&str, String)],
    ) -> Result<serde_json::Value, RequestError> {
        let stored = self.stored().await.ok_or(RequestError::SignedOut)?;
        self.ensure_not_paused()?;
        let mut request = self
            .http
            .request(method, format!("{LICHESS}{path}"))
            .bearer_auth(&stored.token);
        if !form.is_empty() {
            request = request.form(form);
        }
        let response = request
            .send()
            .await
            .map_err(|e| RequestError::failed(without_url(e)))?;
        let body = self
            .check(response)
            .await?
            .bytes()
            .await
            .map_err(|e| RequestError::failed(without_url(e)))?;
        Ok(serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null))
    }

    /// Opens a newline-delimited JSON stream on lichess.org and hands each
    /// line to `on_line` until the server closes it (`Ok(true)`) or `stop`
    /// fires (`Ok(false)`). A `POST` is sent when `form` is given.
    pub async fn stream(
        &self,
        path: &str,
        form: Option<&[(&str, String)]>,
        mut stop: oneshot::Receiver<()>,
        mut on_line: impl FnMut(serde_json::Value),
    ) -> Result<bool, RequestError> {
        let stored = self.stored().await.ok_or(RequestError::SignedOut)?;
        self.ensure_not_paused()?;
        let url = format!("{LICHESS}{path}");
        let request = match form {
            Some(form) => self.stream_http.post(url).form(form),
            None => self.stream_http.get(url),
        }
        .bearer_auth(&stored.token);
        let response = tokio::select! {
            response = request.send() => response.map_err(|e| RequestError::failed(without_url(e)))?,
            _ = &mut stop => return Ok(false),
        };
        let mut response = self.check(response).await?;
        let mut lines = LineBuffer::default();
        loop {
            let chunk = tokio::select! {
                chunk = response.chunk() => chunk.map_err(|e| RequestError::failed(without_url(e)))?,
                _ = &mut stop => return Ok(false),
            };
            let Some(chunk) = chunk else {
                return Ok(true);
            };
            for line in lines.push(&chunk)? {
                on_line(line);
            }
        }
    }

    fn ensure_not_paused(&self) -> Result<(), RequestError> {
        if self
            .paused_until
            .lock()
            .unwrap()
            .is_some_and(|until| Instant::now() < until)
        {
            return Err(RequestError::RateLimited);
        }
        Ok(())
    }

    /// Turns error statuses into `RequestError`s, with Lichess's own message
    /// where it gives one (e.g. "Not your turn, or game already over").
    async fn check(&self, response: reqwest::Response) -> Result<reqwest::Response, RequestError> {
        match response.status() {
            StatusCode::UNAUTHORIZED => {
                // The token was revoked or has expired; it is of no further use.
                self.set_account(None);
                let _ = tokio::task::spawn_blocking(delete_account).await;
                Err(RequestError::SignedOut)
            }
            StatusCode::TOO_MANY_REQUESTS => {
                *self.paused_until.lock().unwrap() = Some(Instant::now() + RATE_LIMIT_PAUSE);
                Err(RequestError::RateLimited)
            }
            status if !status.is_success() => {
                let body = response.text().await.unwrap_or_default();
                Err(RequestError::failed(
                    error_message(&body).unwrap_or_else(|| format!("Lichess answered {status}")),
                ))
            }
            _ => Ok(response),
        }
    }

    async fn exchange_code(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Result<String, String> {
        #[derive(Deserialize)]
        struct TokenResponse {
            access_token: String,
        }
        let response: TokenResponse =
            send_json(self.http.post(format!("{LICHESS}/api/token")).form(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("code_verifier", verifier),
                ("redirect_uri", redirect_uri),
                ("client_id", CLIENT_ID),
            ]))
            .await
            .map_err(|e| format!("Lichess did not hand out a token: {e}"))?;
        Ok(response.access_token)
    }

    async fn fetch_username(&self, token: &str) -> Result<String, String> {
        #[derive(Deserialize)]
        struct AccountResponse {
            username: String,
        }
        let response: AccountResponse = send_json(
            self.http
                .get(format!("{LICHESS}/api/account"))
                .bearer_auth(token),
        )
        .await
        .map_err(|e| format!("could not read the Lichess account: {e}"))?;
        Ok(response.username)
    }
}

async fn send_json<T: DeserializeOwned>(request: RequestBuilder) -> Result<T, String> {
    let response = request.send().await.map_err(without_url)?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Lichess answered {status}"));
    }
    response.json().await.map_err(without_url)
}

/// Splits streamed bytes into JSON lines. Empty lines are keep-alives, and
/// lines that aren't JSON are skipped.
#[derive(Default)]
struct LineBuffer {
    pending: Vec<u8>,
}

impl LineBuffer {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<serde_json::Value>, RequestError> {
        self.pending.extend_from_slice(bytes);
        let mut values = Vec::new();
        while let Some(end) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            let line = line.trim_ascii();
            if !line.is_empty()
                && let Ok(value) = serde_json::from_slice(line)
            {
                values.push(value);
            }
        }
        if self.pending.len() > MAX_STREAM_LINE {
            return Err(RequestError::failed("Lichess sent an overlong line"));
        }
        Ok(values)
    }
}

/// The `error` field of a Lichess error response, if it has one. Some errors
/// are objects of field errors, e.g. `{"error":{"days":["Invalid value"]}}`.
fn error_message(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    match value.get("error")? {
        serde_json::Value::String(message) => Some(message.clone()),
        serde_json::Value::Object(fields) => Some(
            fields
                .iter()
                .map(|(field, errors)| match errors {
                    serde_json::Value::Array(list) => format!(
                        "{field}: {}",
                        list.iter()
                            .filter_map(|e| e.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                    other => format!("{field}: {other}"),
                })
                .collect::<Vec<_>>()
                .join("; "),
        ),
        _ => None,
    }
}

/// Describes a request error without its URL, which can be long and holds the query.
fn without_url(error: reqwest::Error) -> String {
    error.without_url().to_string()
}

/// A random URL-safe string for the PKCE verifier and the OAuth state.
fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("no randomness available: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Serves the redirect listener until a request to `/callback` arrives, and
/// returns its authorization code. Other requests, like a browser's favicon
/// request, get a 404.
async fn receive_code(listener: &TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("the Lichess redirect failed: {e}"))?;
        let Some(target) = read_request_target(&mut stream).await else {
            continue;
        };
        let Some(result) = parse_callback(&target, state) else {
            let _ = respond(&mut stream, "404 Not Found", "Nothing to see here.").await;
            continue;
        };
        let page = match &result {
            Ok(_) => "You are signed in. You can close this tab and return to EnPawssant.",
            Err(_) => {
                "Signing in did not work. You can close this tab and try again in EnPawssant."
            }
        };
        let _ = respond(&mut stream, "200 OK", page).await;
        return result;
    }
}

/// Reads an HTTP request's head and returns its target, e.g. `/callback?code=…`.
async fn read_request_target(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buffer.windows(4).any(|w| w == b"\r\n\r\n") {
        let read = timeout(Duration::from_secs(5), stream.read(&mut chunk))
            .await
            .ok()?
            .ok()?;
        if read == 0 || buffer.len() + read > MAX_REQUEST_BYTES {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let head = String::from_utf8_lossy(&buffer);
    let mut request_line = head.lines().next()?.split(' ');
    match (request_line.next(), request_line.next()) {
        (Some("GET"), Some(target)) => Some(target.to_owned()),
        _ => None,
    }
}

/// Reads the authorization code from a redirect to `/callback`. Returns `None`
/// for other paths.
fn parse_callback(target: &str, expected_state: &str) -> Option<Result<String, String>> {
    let url = Url::parse("http://127.0.0.1").ok()?.join(target).ok()?;
    if url.path() != "/callback" {
        return None;
    }
    let param = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    if param("state").as_deref() != Some(expected_state) {
        return Some(Err(
            "the Lichess redirect did not match this sign-in".to_owned()
        ));
    }
    Some(match (param("code"), param("error")) {
        (Some(code), _) if !code.is_empty() => Ok(code),
        (_, Some(error)) if error == "access_denied" => {
            Err("access to Lichess was denied".to_owned())
        }
        (_, Some(error)) => Err(format!("Lichess refused the sign-in: {error}")),
        _ => Err("the Lichess redirect carried no code".to_owned()),
    })
}

async fn respond(stream: &mut TcpStream, status: &str, message: &str) -> std::io::Result<()> {
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>EnPawssant</title>\
         <body style=\"font:16px system-ui;display:grid;place-items:center;height:90vh;\
         color:#4a3247;background:#fff7f9\"><p>{message}</p>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("the keychain is unavailable: {e}"))
}

fn load_account() -> Option<Stored> {
    let secret = keyring_entry().ok()?.get_password().ok()?;
    serde_json::from_str(&secret).ok()
}

fn save_account(stored: &Stored) -> Result<(), String> {
    let secret = serde_json::to_string(stored).map_err(|e| e.to_string())?;
    keyring_entry()?
        .set_password(&secret)
        .map_err(|e| format!("could not save the Lichess token in the keychain: {e}"))
}

fn delete_account() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!(
            "could not remove the Lichess token from the keychain: {e}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_the_pkce_challenge() {
        // The example from RFC 7636, appendix B.
        assert_eq!(
            code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let token = random_token().unwrap();
        assert_eq!(token.len(), 43);
        assert_ne!(token, random_token().unwrap());
    }

    #[test]
    fn splits_streamed_lines() {
        let mut lines = LineBuffer::default();
        assert!(lines.push(b"{\"type\":\"gameSt").unwrap().is_empty());
        let values = lines
            .push(b"ate\"}\n\n{\"a\":1}\nnot json\n{\"b\"")
            .unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(values[0]["type"], "gameState");
        assert_eq!(values[1]["a"], 1);
        assert_eq!(lines.push(b":2}\r\n").unwrap()[0]["b"], 2);
    }

    #[test]
    fn reads_lichess_error_messages() {
        assert_eq!(
            error_message(r#"{"error":"Not your turn, or game already over"}"#).as_deref(),
            Some("Not your turn, or game already over")
        );
        assert_eq!(
            error_message(r#"{"error":{"days":["Invalid value"]}}"#).as_deref(),
            Some("days: Invalid value")
        );
        assert_eq!(error_message("<html>"), None);
    }

    #[test]
    fn tokens_without_scopes_cannot_play() {
        let old: Stored = serde_json::from_str(r#"{"username":"Mochi","token":"t"}"#).unwrap();
        assert!(!old.account().can_play);
        let new = Stored {
            scopes: SCOPES.iter().map(|s| s.to_string()).collect(),
            ..old
        };
        assert!(new.account().can_play);
    }

    #[test]
    fn reads_the_code_from_the_callback() {
        assert_eq!(
            parse_callback("/callback?code=abc_123&state=s1", "s1"),
            Some(Ok("abc_123".to_owned()))
        );
        assert_eq!(parse_callback("/favicon.ico", "s1"), None);
    }

    #[test]
    fn rejects_bad_callbacks() {
        assert!(matches!(
            parse_callback("/callback?code=abc&state=other", "s1"),
            Some(Err(_))
        ));
        assert!(matches!(
            parse_callback("/callback?code=abc", "s1"),
            Some(Err(_))
        ));
        assert_eq!(
            parse_callback("/callback?error=access_denied&state=s1", "s1"),
            Some(Err("access to Lichess was denied".to_owned()))
        );
        assert!(matches!(
            parse_callback("/callback?state=s1", "s1"),
            Some(Err(_))
        ));
    }
}
