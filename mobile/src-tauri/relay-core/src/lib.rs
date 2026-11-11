pub mod crypto;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::TcpStream,
    sync::{mpsc, Notify},
    time::{timeout, Instant},
};
use tokio_tungstenite::{
    tungstenite::{protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};
use tokio_util::sync::CancellationToken;

const BUFFER_LIMIT: usize = 8 << 20;
const CHUNK_LIMIT: usize = 64 << 10;
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pairing {
    pub relay_url: String,
    pub connect_code: String,
    pub version: u8,
    #[serde(default)]
    pub display_name: Option<String>,
}
impl Pairing {
    pub fn validate(&self) -> Result<url::Url> {
        let parsed = url::Url::parse(&self.relay_url).map_err(|_| "中继地址无效")?;
        let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if self.version != 1
            || self.relay_url.len() > 2048
            || parsed.host_str().is_none()
            || (parsed.scheme() != "https" && !(parsed.scheme() == "http" && local))
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.path() != "/"
            || crypto::decode(&self.connect_code)?.len() != 32
        {
            return Err("配对信息无效".into());
        }
        if self
            .display_name
            .as_ref()
            .is_some_and(|n| n.chars().count() > 40 || n.chars().any(char::is_control))
        {
            return Err("实例名称无效".into());
        }
        Ok(parsed)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateEvent {
    pub state: &'static str,
    pub error: Option<String>,
    pub revision: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResponseHead {
    pub status: u16,
    pub headers: HashMap<String, String>,
}
#[derive(Deserialize)]
pub struct Request {
    pub id: String,
    pub path: String,
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Vec<u8>,
}
impl Request {
    fn validate(&self) -> Result<()> {
        if self.id.is_empty()
            || self.id.len() > 128
            || self.id.starts_with("__")
            || !self.path.starts_with("/api/")
            || self.path.contains(['\\', '\r', '\n', '#'])
            || self.path.len() > 8192
            || self.body.len() > 6 << 20
            || !matches!(
                self.method.as_str(),
                "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
            )
        {
            return Err("无效的 Loopra API 请求".into());
        }
        if self.headers.len() > 4
            || self.headers.iter().any(|(name, value)| {
                !matches!(
                    name.as_str(),
                    "content-type" | "accept" | "x-request-id" | "range"
                ) || value.len() > 8192
                    || value.contains(['\r', '\n'])
            })
        {
            return Err("无效的 Loopra 请求头".into());
        }
        // Resolve dot segments before enforcing the desktop API boundary.
        let target = url::Url::parse(&format!("https://loopra.invalid{}", self.path))
            .map_err(|_| "无效的 Loopra API 路径")?;
        if !target.path().starts_with("/api/") {
            return Err("无效的 Loopra API 路径".into());
        }
        Ok(())
    }
}

#[derive(Default)]
struct Pending {
    head: Option<ResponseHead>,
    chunks: VecDeque<Vec<u8>>,
    buffered: usize,
    total: usize,
    ended: bool,
    error: Option<String>,
    no_body: bool,
    notify: Arc<Notify>,
}
#[derive(Default)]
struct Shared {
    health_checks: u64,
    health_notify: Arc<Notify>,
    status: Option<StateEvent>,
    connected: bool,
    epoch: u64,
    pending: HashMap<String, Pending>,
    buffered: usize,
    cancelled: VecDeque<String>,
}
enum Command {
    Send {
        id: String,
        epoch: u64,
        frame: Value,
    },
    Cancel {
        id: String,
        epoch: u64,
    },
}

pub struct Client {
    shared: Arc<Mutex<Shared>>,
    commands: mpsc::Sender<Command>,
    stop: CancellationToken,
    resume: Arc<Notify>,
}
impl Drop for Client {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
impl Client {
    pub fn start(
        pairing: Pairing,
        state: impl Fn(StateEvent) -> bool + Send + Sync + 'static,
    ) -> Result<Self> {
        pairing.validate()?;
        let shared = Arc::new(Mutex::new(Shared::default()));
        let (commands, receiver) = mpsc::channel(64);
        let stop = CancellationToken::new();
        let resume = Arc::new(Notify::new());
        let client = Self {
            shared: shared.clone(),
            commands,
            stop: stop.clone(),
            resume: resume.clone(),
        };
        // The actor owns all sockets, cipher counters and reconnect timers. No WebView callbacks drive it.
        tokio::spawn(async move {
            run(pairing, shared, receiver, stop, resume, state).await;
        });
        Ok(client)
    }
    pub fn resume(&self) {
        self.resume.notify_one();
    }
    pub async fn check(&self) -> Result<()> {
        let (revision, checks, notify) = {
            let shared = self.shared.lock().map_err(|_| "连接状态不可用")?;
            (
                shared.status.as_ref().map_or(0, |s| s.revision),
                shared.health_checks,
                shared.health_notify.clone(),
            )
        };
        self.resume();
        let wait = async {
            loop {
                let wake = notify.notified();
                tokio::pin!(wake);
                wake.as_mut().enable();
                {
                    let shared = self.shared.lock().map_err(|_| "连接状态不可用")?;
                    if self.stop.is_cancelled() {
                        return Err("连接已关闭".into());
                    }
                    if shared.connected
                        && (shared.health_checks != checks
                            || shared
                                .status
                                .as_ref()
                                .is_some_and(|s| s.state == "connected" && s.revision > revision))
                    {
                        return Ok(());
                    }
                }
                tokio::select! {
                    _ = self.stop.cancelled() => return Err("连接已关闭".into()),
                    _ = &mut wake => {},
                }
            }
        };
        timeout(Duration::from_secs(35), wait)
            .await
            .unwrap_or_else(|_| Err("连接仍在恢复，将继续自动重连".into()))
    }
    pub fn status(&self) -> StateEvent {
        self.shared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .status
            .clone()
            .unwrap_or(StateEvent {
                state: "connecting",
                error: None,
                revision: 0,
            })
    }
    pub fn close(&self) {
        self.stop.cancel();
        fail_pending(&self.shared, "连接已关闭");
    }
    pub async fn request(&self, request: Request) -> Result<ResponseHead> {
        request.validate()?;
        let id = request.id.clone();
        let notify = Arc::new(Notify::new());
        let epoch = {
            let mut shared = self.shared.lock().map_err(|_| "连接状态不可用")?;
            if !shared.connected || self.stop.is_cancelled() {
                return Err("桌面已断开，正在重新连接".into());
            }
            if shared.cancelled.contains(&id) {
                return Err("请求已取消".into());
            }
            // The desktop admits 64 requests per tunnel; reserve one for the end-to-end health probe.
            if shared.pending.len() >= 63 || shared.pending.contains_key(&id) {
                return Err("请求过多或请求标识重复".into());
            }
            shared.pending.insert(
                id.clone(),
                Pending {
                    no_body: request.method == "HEAD",
                    notify: notify.clone(),
                    ..Default::default()
                },
            );
            shared.epoch
        };
        let frame = json!({"t":"hreq", "id":id, "method":request.method, "path":request.path, "headers":request.headers, "b":crypto::encode(&request.body)});
        if self
            .commands
            .try_send(Command::Send {
                id: id.clone(),
                epoch,
                frame,
            })
            .is_err()
        {
            self.remove(&id);
            return Err("请求队列已满，请稍后重试".into());
        }
        let wait = async {
            loop {
                let wake = notify.notified();
                {
                    let shared = self.shared.lock().map_err(|_| "连接状态不可用")?;
                    let pending = shared.pending.get(&id).ok_or("请求已取消")?;
                    if let Some(error) = &pending.error {
                        return Err(error.clone());
                    }
                    if let Some(head) = &pending.head {
                        return Ok(head.clone());
                    }
                }
                wake.await;
            }
        };
        let result = timeout(Duration::from_secs(60), wait)
            .await
            .unwrap_or_else(|_| Err("桌面响应超时".into()));
        if result.is_err() {
            self.cancel(&id).await;
        }
        result
    }
    pub async fn read(&self, id: &str) -> Result<Vec<u8>> {
        loop {
            let notify;
            {
                let mut shared = self.shared.lock().map_err(|_| "连接状态不可用")?;
                let pending = shared.pending.get_mut(id).ok_or("请求已取消")?;
                if let Some(error) = &pending.error {
                    let error = error.clone();
                    drop(shared);
                    self.remove(id);
                    return Err(error);
                }
                if let Some(chunk) = pending.chunks.pop_front() {
                    pending.buffered -= chunk.len();
                    shared.buffered -= chunk.len();
                    return Ok(chunk);
                }
                if pending.ended {
                    drop(shared);
                    self.remove(id);
                    return Ok(Vec::new());
                }
                notify = pending.notify.clone();
            }
            notify.notified().await;
        }
    }
    fn remove(&self, id: &str) -> Option<u64> {
        let mut shared = self.shared.lock().ok()?;
        let pending = shared.pending.remove(id)?;
        shared.buffered -= pending.buffered;
        pending.notify.notify_one();
        Some(shared.epoch)
    }
    pub async fn cancel(&self, id: &str) {
        let epoch = {
            let mut shared = self.shared.lock().unwrap_or_else(|e| e.into_inner());
            // IPC cancellation may be dispatched before its async request command.
            shared.cancelled.push_back(id.into());
            if shared.cancelled.len() > 256 {
                shared.cancelled.pop_front();
            }
            if let Some(pending) = shared.pending.remove(id) {
                shared.buffered -= pending.buffered;
                pending.notify.notify_one();
                Some(shared.epoch)
            } else {
                None
            }
        };
        if let Some(epoch) = epoch {
            tokio::select! {
                _ = self.stop.cancelled() => {},
                // Cancellation is never silently dropped when the request queue is full.
                _ = self.commands.send(Command::Cancel {id:id.into(), epoch}) => {},
            }
        }
    }
}
fn fail_pending(shared: &Mutex<Shared>, error: &str) {
    let mut shared = shared.lock().unwrap_or_else(|e| e.into_inner());
    shared.connected = false;
    shared.epoch = shared.epoch.wrapping_add(1);
    shared.buffered = 0;
    for pending in shared.pending.values_mut() {
        pending.chunks.clear();
        pending.buffered = 0;
        pending.error = Some(error.into());
        pending.notify.notify_one();
    }
}
async fn send(socket: &mut Socket, message: Message) -> Result<()> {
    timeout(Duration::from_secs(10), socket.send(message))
        .await
        .map_err(|_| "中继发送超时")?
        .map_err(|_| "中继发送失败".into())
}
async fn next(socket: &mut Socket) -> Result<Message> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Ping(data))) => send(socket, Message::Pong(data)).await?,
            Some(Ok(Message::Pong(_))) => {}
            Some(Ok(Message::Close(_))) | None => return Err("中继已断开，正在重新连接".into()),
            Some(Ok(message)) => return Ok(message),
            Some(Err(_)) => return Err("中继读取失败".into()),
        }
    }
}
async fn establish(pairing: &Pairing) -> Result<(Socket, crypto::Session)> {
    let mut url = pairing.validate()?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme).map_err(|_| "中继地址无效")?;
    url.set_path(&format!(
        "/c/{}/__loopra_e2e__/v1",
        crypto::routing_id(&pairing.connect_code)?
    ));
    let config = WebSocketConfig::default()
        .max_message_size(Some(BUFFER_LIMIT))
        .max_frame_size(Some(BUFFER_LIMIT));
    let (mut socket, _) =
        tokio_tungstenite::connect_async_with_config(url.as_str(), Some(config), false)
            .await
            .map_err(|_| "无法连接中继，请检查网络和 HTTPS 域名")?;
    let (handshake, hello) = crypto::Handshake::new()?;
    send(
        &mut socket,
        Message::Text(
            serde_json::to_string(&hello)
                .map_err(|_| "握手编码失败")?
                .into(),
        ),
    )
    .await?;
    let message = next(&mut socket).await?;
    let Message::Text(raw) = message else {
        return Err("桌面握手数据无效".into());
    };
    if raw.len() > 16384 {
        return Err("桌面握手数据无效".into());
    }
    let (mut session, confirm) = handshake.finish(
        &pairing.connect_code,
        serde_json::from_str(&raw).map_err(|_| "桌面握手数据无效")?,
    )?;
    send(&mut socket, Message::Text(confirm.to_string().into())).await?;
    // A usable connection includes the application's protocol check, also on reconnect.
    let wire = session.seal(
        &json!({"t":"hreq", "id":"__handshake", "method":"GET", "path":"/api/mobile/handshake"}),
    )?;
    send(&mut socket, Message::Binary(wire.into())).await?;
    let mut body = Vec::new();
    let mut headers = false;
    loop {
        let Message::Binary(wire) = next(&mut socket).await? else {
            return Err("隧道响应无效".into());
        };
        let frame = session.open(&wire)?;
        if frame["id"] != "__handshake" {
            return Err("桌面协议验证失败".into());
        }
        match frame["t"].as_str() {
            Some("hres") if !headers && frame["status"] == 200 => headers = true,
            Some("hchunk") if headers => {
                body.extend(crypto::decode(
                    frame["b"].as_str().ok_or("桌面协议验证失败")?,
                )?);
                if body.len() > CHUNK_LIMIT {
                    return Err("桌面协议验证失败".into());
                }
            }
            Some("hend") if headers => break,
            _ => return Err("桌面协议验证失败".into()),
        }
    }
    let body: Value = serde_json::from_slice(&body).map_err(|_| "桌面协议验证失败")?;
    if body["success"] != true
        || body["data"]["protocol"] != "loopra-relay"
        || body["data"]["version"] != 1
    {
        return Err("桌面尚未支持 Loopra Mobile，请更新桌面端后重新配对".into());
    }
    Ok((socket, session))
}

fn receive(shared: &Mutex<Shared>, frame: Value) -> Result<Option<String>> {
    let kind = frame["t"].as_str().ok_or("隧道响应无效")?;
    if !matches!(kind, "hres" | "hchunk" | "hend" | "herr") {
        return Err("未知的 Loopra 响应帧".into());
    }
    let id = frame["id"].as_str().ok_or("隧道请求标识无效")?;
    let mut shared = shared.lock().map_err(|_| "连接状态不可用")?;
    let global_buffered = shared.buffered;
    let Some(pending) = shared.pending.get_mut(id) else {
        return Ok(None);
    };
    if pending.error.is_some() {
        return Ok(None);
    }
    if pending.ended {
        return Err("HTTP 响应已结束".into());
    }
    let mut added = 0;
    let mut cancel = false;
    match kind {
        "hres" => {
            let status = frame["status"]
                .as_u64()
                .filter(|n| (200..=599).contains(n))
                .ok_or("HTTP 响应状态无效")? as u16;
            if pending.head.is_some() {
                return Err("HTTP 响应头重复".into());
            }
            let headers: HashMap<String, String> = match frame.get("headers") {
                Some(value) => {
                    serde_json::from_value(value.clone()).map_err(|_| "HTTP 响应头无效")?
                }
                None => HashMap::new(),
            };
            if headers.iter().any(|(k, v)| {
                !matches!(
                    k.to_ascii_lowercase().as_str(),
                    "content-type"
                        | "content-length"
                        | "content-disposition"
                        | "content-encoding"
                        | "cache-control"
                        | "etag"
                        | "last-modified"
                        | "accept-ranges"
                        | "content-range"
                        | "location"
                        | "allow"
                        | "expires"
                        | "vary"
                ) || v.contains(['\r', '\n'])
            }) {
                return Err("HTTP 响应头无效".into());
            }
            pending.no_body |= matches!(status, 204 | 205 | 304);
            pending.head = Some(ResponseHead { status, headers });
        }
        "hchunk" => {
            let head = pending.head.as_ref().ok_or("HTTP 响应顺序无效")?;
            let chunk = crypto::decode(frame["b"].as_str().ok_or("HTTP 响应编码无效")?)?;
            if chunk.len() > CHUNK_LIMIT {
                return Err("HTTP 响应分块过大".into());
            }
            pending.total += chunk.len();
            let sse = head.headers.iter().any(|(k, v)| {
                k.eq_ignore_ascii_case("content-type")
                    && v.split(';')
                        .next()
                        .is_some_and(|s| s.trim().eq_ignore_ascii_case("text/event-stream"))
            });
            let limit = if sse { 256 << 20 } else { 16 << 20 };
            if pending.total > limit || global_buffered + chunk.len() > BUFFER_LIMIT {
                pending.error = Some("响应缓冲区或累计响应超过限制，请重试".into());
                cancel = true;
            } else if !pending.no_body && !chunk.is_empty() {
                added = chunk.len();
                pending.buffered += added;
                pending.chunks.push_back(chunk);
            }
        }
        "hend" => {
            if pending.head.is_none() {
                return Err("HTTP 响应不完整".into());
            }
            pending.ended = true;
        }
        "herr" => {
            pending.error = Some(
                frame["message"]
                    .as_str()
                    .unwrap_or("桌面请求失败")
                    .chars()
                    .take(1024)
                    .collect(),
            );
        }
        _ => unreachable!(),
    }
    let released = if pending.error.is_some() {
        let bytes = pending.buffered;
        pending.chunks.clear();
        pending.buffered = 0;
        bytes
    } else {
        0
    };
    pending.notify.notify_one();
    shared.buffered = shared.buffered + added - released;
    Ok(cancel.then(|| id.to_string()))
}

async fn serve(
    socket: &mut Socket,
    session: &mut crypto::Session,
    shared: &Mutex<Shared>,
    receiver: &mut mpsc::Receiver<Command>,
    resume: &Notify,
) -> Result<()> {
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_received = Instant::now();
    let mut probe: Option<Probe> = None;
    loop {
        let deadline = probe
            .as_ref()
            .map(|p| p.deadline)
            .unwrap_or_else(|| Instant::now() + Duration::from_secs(86400));
        tokio::select! {
            _ = resume.notified() => {
                // Preserve healthy streams across Activity pause/resume. Only a failed end-to-end probe reconnects.
                if probe.is_none() { probe = Some(start_probe(socket, session).await?); }
            },
            _ = tokio::time::sleep_until(deadline), if probe.is_some() => return Err("桌面连接检查超时，正在重新连接".into()),
            command = receiver.recv() => {
                let Some(command) = command else { return Err("连接已关闭".into()); };
                let frame = {
                    let state = shared.lock().map_err(|_| "连接状态不可用")?;
                    match command {
                        Command::Send {id, epoch, frame} if state.connected && state.epoch == epoch && state.pending.get(&id).is_some_and(|p| p.error.is_none()) => Some(frame),
                        Command::Cancel {id, epoch} if state.connected && state.epoch == epoch => Some(json!({"t":"hcancel", "id":id})),
                        _ => None,
                    }
                };
                if let Some(frame) = frame { send(socket, Message::Binary(session.seal(&frame)?.into())).await?; }
            },
            message = socket.next() => {
                last_received = Instant::now();
                match message {
                    Some(Ok(Message::Binary(wire))) => {
                        let frame = session.open(&wire)?;
                        if frame["id"] == "__probe" {
                            let pending = probe.as_mut().ok_or("连接检查响应顺序无效")?;
                            if pending.receive(&frame)? {
                                probe = None;
                                let mut shared = shared.lock().map_err(|_| "连接状态不可用")?;
                                shared.health_checks = shared.health_checks.wrapping_add(1);
                                shared.health_notify.notify_waiters();
                            }
                        } else if let Some(id) = receive(shared, frame)? {
                            send(socket, Message::Binary(session.seal(&json!({"t":"hcancel", "id":id}))?.into())).await?;
                        }
                    },
                    Some(Ok(Message::Ping(data))) => send(socket, Message::Pong(data)).await?,
                    Some(Ok(Message::Pong(_))) => {},
                    _ => return Err("中继已断开，正在重新连接".into()),
                }
            },
            _ = heartbeat.tick() => {
                if last_received.elapsed() > Duration::from_secs(60) { return Err("中继连接已失活，正在重新连接".into()); }
                send(socket, Message::Ping(Vec::new().into())).await?;
                if probe.is_none() { probe = Some(start_probe(socket, session).await?); }
            }
        }
    }
}
struct Probe {
    deadline: Instant,
    headers: bool,
    received: usize,
}
impl Probe {
    fn receive(&mut self, frame: &Value) -> Result<bool> {
        match frame["t"].as_str() {
            Some("hres") if !self.headers && frame["status"] == 200 => {
                self.headers = true;
                Ok(false)
            }
            Some("hchunk") if self.headers => {
                // The desktop's in-process HTTP writer can emit a HEAD body.
                // Drain its bounded frames just like Pending::no_body, through hend.
                let chunk = crypto::decode(frame["b"].as_str().ok_or("连接检查响应编码无效")?)?;
                self.received += chunk.len();
                if self.received > CHUNK_LIMIT {
                    return Err("连接检查响应过大".into());
                }
                Ok(false)
            }
            Some("hend") if self.headers => Ok(true),
            _ => Err("桌面连接检查响应无效".into()),
        }
    }
}
async fn start_probe(socket: &mut Socket, session: &mut crypto::Session) -> Result<Probe> {
    // A relay can answer WebSocket Ping while its desktop tunnel is dead. Probe the actual desktop API.
    let wire = session.seal(
        &json!({"t":"hreq", "id":"__probe", "method":"HEAD", "path":"/api/mobile/handshake"}),
    )?;
    send(socket, Message::Binary(wire.into())).await?;
    Ok(Probe {
        deadline: Instant::now() + Duration::from_secs(10),
        headers: false,
        received: 0,
    })
}
fn publish(
    shared: &Mutex<Shared>,
    state: &'static str,
    error: Option<String>,
    callback: &impl Fn(StateEvent) -> bool,
) {
    let event = {
        let mut shared = shared.lock().unwrap_or_else(|e| e.into_inner());
        let revision = shared.status.as_ref().map_or(1, |s| s.revision + 1);
        let event = StateEvent {
            state,
            error,
            revision,
        };
        shared.status = Some(event.clone());
        shared.health_notify.notify_waiters();
        event
    };
    // WebView suspension must never own the socket lifetime. A foreground UI can query this snapshot.
    let _ = callback(event);
}
async fn run(
    pairing: Pairing,
    shared: Arc<Mutex<Shared>>,
    mut receiver: mpsc::Receiver<Command>,
    stop: CancellationToken,
    resume: Arc<Notify>,
    state: impl Fn(StateEvent) -> bool,
) {
    let mut attempts = 0u32;
    loop {
        if stop.is_cancelled() {
            break;
        }
        publish(&shared, "connecting", None, &state);
        let established = tokio::select! {
            _ = stop.cancelled() => break,
            result = timeout(Duration::from_secs(25), establish(&pairing)) => result.unwrap_or_else(|_| Err("桌面连接超时，请确认桌面在线且网络可达".into())),
        };
        let error = match established {
            Ok((mut socket, mut session)) => {
                shared.lock().unwrap_or_else(|e| e.into_inner()).connected = true;
                attempts = 0;
                publish(&shared, "connected", None, &state);
                let result = tokio::select! {
                    _ = stop.cancelled() => Err("连接已关闭".into()),
                    result = serve(&mut socket, &mut session, &shared, &mut receiver, &resume) => result,
                };
                // Dropping the socket closes TCP even if a graceful WebSocket close would block.
                result.err().unwrap_or_else(|| "中继已断开".into())
            }
            Err(error) => error,
        };
        fail_pending(&shared, &error);
        while receiver.try_recv().is_ok() {}
        if stop.is_cancelled() {
            break;
        }
        let fatal = error.contains("身份验证失败")
            || error.contains("协议不兼容")
            || error.contains("桌面尚未支持");
        publish(
            &shared,
            if fatal { "closed" } else { "disconnected" },
            Some(error),
            &state,
        );
        if fatal {
            stop.cancel();
            break;
        }
        // Remain bounded and keep recovering after long outages; never replay an old request.
        let delay = [900, 2200, 5000, 10000, 30000][attempts.min(4) as usize];
        attempts = attempts.saturating_add(1);
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = resume.notified() => attempts = 0,
            _ = tokio::time::sleep(Duration::from_millis(delay)) => {},
        }
    }
    fail_pending(&shared, "连接已关闭");
    if shared
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .status
        .as_ref()
        .is_none_or(|s| s.state != "closed")
    {
        publish(&shared, "closed", None, &state);
    }
}

#[cfg(test)]
mod tests;
