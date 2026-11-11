use super::*;

#[test]
fn health_probe_drains_head_body_and_keeps_response_validation() {
    let probe = || Probe {
        deadline: Instant::now(),
        headers: false,
        received: 0,
    };
    let mut response = probe();
    assert!(response.receive(&json!({"t":"hchunk", "b":"AA"})).is_err());
    assert!(response
        .receive(&json!({"t":"hres", "status":503}))
        .is_err());
    assert!(!response
        .receive(&json!({"t":"hres", "status":200}))
        .unwrap());
    assert!(response
        .receive(&json!({"t":"hres", "status":200}))
        .is_err());
    assert!(response.receive(&json!({"t":"hchunk", "b":"!"})).is_err());
    assert!(!response
        .receive(&json!({"t":"hchunk", "b":crypto::encode(b"desktop HEAD body")}))
        .unwrap());
    assert!(response.receive(&json!({"t":"hend"})).unwrap());
    let mut empty = probe();
    empty.receive(&json!({"t":"hres", "status":200})).unwrap();
    assert!(empty.receive(&json!({"t":"hend"})).unwrap());
    let mut oversized = probe();
    oversized
        .receive(&json!({"t":"hres", "status":200}))
        .unwrap();
    oversized
        .receive(&json!({"t":"hchunk", "b":crypto::encode(&vec![0; CHUNK_LIMIT])}))
        .unwrap();
    assert!(oversized
        .receive(&json!({"t":"hchunk", "b":"AA"}))
        .unwrap_err()
        .contains("过大"));
}

#[tokio::test]
async fn empty_head_health_response_keeps_healthy_connection() {
    let (_peer, pairing) = peer_on(0, "head-empty");
    let (send, mut events) = mpsc::unbounded_channel();
    let client = Client::start(pairing, move |event| send.send(event).is_ok()).unwrap();
    connected(&mut events).await;
    let revision = client.status().revision;
    client.check().await.unwrap();
    assert_eq!(client.status().revision, revision);
    client.close();
}

#[test]
fn response_order_binary_identity_and_buffer_limits() {
    let mut initial = Shared::default();
    initial.pending.insert("a".into(), Pending::default());
    initial.pending.insert("b".into(), Pending::default());
    let state = Mutex::new(initial);
    assert!(receive(&state, json!({"t":"hchunk", "id":"a", "b":"AA"})).is_err());
    receive(&state, json!({"t":"hres", "id":"a", "status":200})).unwrap();
    receive(
        &state,
        json!({"t":"hres", "id":"b", "status":200, "headers":{"content-type":"text/event-stream"}}),
    )
    .unwrap();
    receive(
        &state,
        json!({"t":"hchunk", "id":"a", "b":crypto::encode(&[0, 1, 127, 128, 255])}),
    )
    .unwrap();
    receive(
        &state,
        json!({"t":"hchunk", "id":"b", "b":crypto::encode("你好".as_bytes())}),
    )
    .unwrap();
    {
        let shared = state.lock().unwrap();
        assert_eq!(shared.pending["a"].chunks[0], [0, 1, 127, 128, 255]);
        assert_eq!(shared.pending["b"].chunks[0], "你好".as_bytes());
        assert_eq!(shared.buffered, 11);
    }
    let chunk = crypto::encode(&vec![1; CHUNK_LIMIT]);
    loop {
        let result = receive(&state, json!({"t":"hchunk", "id":"b", "b":chunk})).unwrap();
        if let Some(id) = result {
            assert_eq!(id, "b");
            break;
        }
    }
    let shared = state.lock().unwrap();
    assert_eq!(shared.buffered, 5);
    assert!(shared.pending["b"].error.is_some());
    assert!(shared.pending["b"].chunks.is_empty());
}

#[test]
fn disconnect_fails_old_requests_and_preserves_epoch_boundary() {
    let mut shared = Shared {
        connected: true,
        ..Default::default()
    };
    shared.pending.insert("old".into(), Pending::default());
    let state = Mutex::new(shared);
    receive(&state, json!({"t":"hres", "id":"old", "status":200})).unwrap();
    receive(&state, json!({"t":"hchunk", "id":"old", "b":"AA"})).unwrap();
    fail_pending(&state, "offline");
    let shared = state.lock().unwrap();
    assert!(!shared.connected);
    assert_eq!(shared.epoch, 1);
    assert_eq!(shared.buffered, 0);
    assert_eq!(shared.pending["old"].error.as_deref(), Some("offline"));
    assert!(shared.pending["old"].chunks.is_empty());
}

#[test]
fn validates_pairing_and_request_boundaries() {
    let pairing = Pairing {
        relay_url: "https://relay.example".into(),
        connect_code: crypto::encode(&[7; 32]),
        version: 1,
        display_name: None,
    };
    pairing.validate().unwrap();
    for url in [
        "http://relay.example",
        "https://user@relay.example",
        "https://relay.example/path",
        "https://relay.example?key=bad",
    ] {
        assert!(Pairing {
            relay_url: url.into(),
            ..pairing.clone()
        }
        .validate()
        .is_err());
    }
    for path in [
        "//evil/api/x",
        "/api/../private",
        "/api/%2e%2e/private",
        "/api/\\private",
        "/private",
    ] {
        assert!(
            Request {
                id: "id".into(),
                path: path.into(),
                method: "POST".into(),
                headers: HashMap::new(),
                body: vec![]
            }
            .validate()
            .is_err(),
            "{path}"
        );
    }
    assert!(receive(
        &Mutex::new(Shared::default()),
        json!({"t":"unknown", "id":"id"})
    )
    .is_err());
}

struct Peer(std::process::Child);
impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn peer() -> (Peer, Pairing) {
    peer_on(0, "")
}
fn peer_on(port: u16, mode: &str) -> (Peer, Pairing) {
    use std::io::BufRead;
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/native-relay-peer.mjs");
    let mut child = std::process::Command::new("node")
        .arg(script)
        .arg(port.to_string())
        .arg(mode)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .expect("node and mobile dependencies are required for native protocol tests");
    let output = child.stdout.take().unwrap();
    let mut line = String::new();
    std::io::BufReader::new(output)
        .read_line(&mut line)
        .unwrap();
    assert!(
        line.starts_with("http://127.0.0.1:"),
        "responder did not start"
    );
    (
        Peer(child),
        Pairing {
            relay_url: line.trim().into(),
            connect_code: crypto::encode(&[7; 32]),
            version: 1,
            display_name: None,
        },
    )
}
async fn connected(events: &mut tokio::sync::mpsc::UnboundedReceiver<StateEvent>) {
    timeout(Duration::from_secs(8), async {
        loop {
            let event = events.recv().await.expect("connection actor stopped");
            if event.state == "connected" {
                break;
            }
            assert_ne!(event.state, "closed", "{:?}", event.error);
        }
    })
    .await
    .expect("connection did not recover");
}
fn api(id: &str, path: &str, body: &[u8]) -> Request {
    Request {
        id: id.into(),
        path: path.into(),
        method: "POST".into(),
        headers: HashMap::new(),
        body: body.into(),
    }
}

#[tokio::test]
async fn native_webcrypto_interop_stream_cancel_resume_disconnect_and_no_replay() {
    let (_peer, pairing) = peer();
    let (send, mut events) = mpsc::unbounded_channel();
    let client = Client::start(pairing, move |event| send.send(event).is_ok()).unwrap();
    connected(&mut events).await;
    let (one, two) = tokio::join!(
        client.request(api("one", "/api/echo", &[0, 1, 127, 128, 255])),
        client.request(api("two", "/api/echo", "你好".as_bytes()))
    );
    assert_eq!(one.unwrap().status, 200);
    assert_eq!(two.unwrap().status, 200);
    assert_eq!(client.read("two").await.unwrap(), "你好".as_bytes());
    assert_eq!(client.read("one").await.unwrap(), [0, 1, 127, 128, 255]);
    assert!(client.read("two").await.unwrap().is_empty());
    assert!(client.read("one").await.unwrap().is_empty());

    let stream = client.request(api("sse", "/api/sse", &[])).await.unwrap();
    assert_eq!(stream.headers["content-type"], "text/event-stream");
    assert!(String::from_utf8(client.read("sse").await.unwrap())
        .unwrap()
        .contains("你好"));
    assert!(client.read("sse").await.unwrap().is_empty());
    client
        .request(api("cancel", "/api/wait", &[]))
        .await
        .unwrap();
    client.cancel("cancel").await;
    client
        .request(api("check", "/api/cancelled/cancel", &[]))
        .await
        .unwrap();
    assert_eq!(client.read("check").await.unwrap(), b"true");
    assert!(client.read("check").await.unwrap().is_empty());

    client.cancel("early").await;
    assert!(client
        .request(api("early", "/api/echo", b"must not send"))
        .await
        .unwrap_err()
        .contains("取消"));
    client.request(api("old", "/api/wait", &[])).await.unwrap();
    client.resume();
    client
        .request(api("resumed", "/api/echo", b"still connected"))
        .await
        .unwrap();
    assert_eq!(client.read("resumed").await.unwrap(), b"still connected");
    assert!(client.shared.lock().unwrap().pending["old"].error.is_none());
    assert!(timeout(
        Duration::from_secs(2),
        client.request(api("drop", "/api/drop", b"must not replay"))
    )
    .await
    .unwrap()
    .is_err());
    assert!(client.read("old").await.is_err());
    connected(&mut events).await;
    client
        .request(api("alive", "/api/echo", b"recovered"))
        .await
        .unwrap();
    assert_eq!(client.read("alive").await.unwrap(), b"recovered");
    assert!(client.read("alive").await.unwrap().is_empty());
    client.close();
    assert!(client
        .request(api("closed", "/api/echo", &[]))
        .await
        .is_err());
}

#[tokio::test]
async fn native_close_cancels_setup_and_rejects_old_reads() {
    let (_peer, pairing) = peer();
    let (send, mut events) = mpsc::unbounded_channel();
    let client = Client::start(pairing, move |event| send.send(event).is_ok()).unwrap();
    connected(&mut events).await;
    client
        .request(api("waiting", "/api/wait", &[]))
        .await
        .unwrap();
    let reading = client.read("waiting");
    client.close();
    assert!(timeout(Duration::from_secs(1), reading)
        .await
        .unwrap()
        .is_err());
    client.close();
}

#[tokio::test]
async fn native_recovers_from_offline_start_without_frontend_timers() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let pairing = Pairing {
        relay_url: format!("http://127.0.0.1:{port}"),
        connect_code: crypto::encode(&[7; 32]),
        version: 1,
        display_name: None,
    };
    let (send, mut events) = mpsc::unbounded_channel();
    let client = Client::start(pairing, move |event| send.send(event).is_ok()).unwrap();
    timeout(Duration::from_secs(3), async {
        while events.recv().await.unwrap().state != "disconnected" {}
    })
    .await
    .unwrap();
    let (_peer, _) = peer_on(port, "");
    connected(&mut events).await;
    client
        .request(api("online", "/api/echo", b"online"))
        .await
        .unwrap();
    assert_eq!(client.read("online").await.unwrap(), b"online");
    client.close();
}

#[tokio::test]
async fn native_close_interrupts_an_unfinished_handshake() {
    let (_peer, pairing) = peer_on(0, "stall");
    let (send, mut events) = mpsc::unbounded_channel();
    let client = Client::start(pairing, move |event| send.send(event).is_ok()).unwrap();
    assert_eq!(events.recv().await.unwrap().state, "connecting");
    client.close();
    assert_eq!(
        timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap()
            .state,
        "closed"
    );
    assert!(events.recv().await.is_none());
}

#[tokio::test]
async fn paused_webview_delivery_does_not_own_native_connection_lifetime() {
    let (_peer, pairing) = peer();
    let client = Client::start(pairing, |_| false).unwrap();
    timeout(Duration::from_secs(5), async {
        while client.status().state != "connected" {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    client
        .request(api("background", "/api/echo", b"background"))
        .await
        .unwrap();
    client.resume();
    assert_eq!(client.read("background").await.unwrap(), b"background");
    assert_eq!(client.status().state, "connected");
    client.close();
}

#[tokio::test]
async fn foreground_probe_detects_a_dead_desktop_even_if_relay_still_pongs() {
    let (_peer, pairing) = peer_on(0, "stale");
    let (send, mut events) = mpsc::unbounded_channel();
    let client = Client::start(pairing, move |event| send.send(event).is_ok()).unwrap();
    connected(&mut events).await;
    client.request(api("old", "/api/wait", &[])).await.unwrap();
    client.resume();
    assert!(timeout(Duration::from_secs(13), client.read("old"))
        .await
        .unwrap()
        .unwrap_err()
        .contains("超时"));
    connected(&mut events).await;
    client
        .request(api("new", "/api/echo", b"recovered"))
        .await
        .unwrap();
    assert_eq!(client.read("new").await.unwrap(), b"recovered");
    client.close();
}

#[tokio::test]
async fn saturated_request_pool_reserves_capacity_for_connection_health() {
    let (_peer, pairing) = peer();
    let (send, mut events) = mpsc::unbounded_channel();
    let client = Client::start(pairing, move |event| send.send(event).is_ok()).unwrap();
    connected(&mut events).await;
    for number in 0..63 {
        client
            .request(api(&format!("wait-{number}"), "/api/wait", &[]))
            .await
            .unwrap();
    }
    assert!(client
        .request(api("overflow", "/api/echo", &[]))
        .await
        .unwrap_err()
        .contains("请求过多"));
    client.resume();
    client.cancel("wait-0").await;
    client
        .request(api("alive", "/api/echo", b"alive"))
        .await
        .unwrap();
    assert_eq!(client.read("alive").await.unwrap(), b"alive");
    assert_eq!(client.status().state, "connected");
    client.close();
}

#[tokio::test]
async fn manual_check_confirms_health_without_replacing_socket_and_can_be_cancelled() {
    let (_peer, pairing) = peer();
    let (send, mut events) = mpsc::unbounded_channel();
    let client = Client::start(pairing, move |event| send.send(event).is_ok()).unwrap();
    connected(&mut events).await;
    client
        .request(api("active", "/api/wait", &[]))
        .await
        .unwrap();
    let revision = client.status().revision;
    client.check().await.unwrap();
    assert_eq!(client.status().revision, revision);
    assert!(client.shared.lock().unwrap().pending["active"]
        .error
        .is_none());
    client.close();
    assert!(client.check().await.unwrap_err().contains("关闭"));
}

#[tokio::test]
#[ignore = "Build mobile/tests/native-relay-desktop.go and set LOOPRA_NATIVE_DESKTOP_FIXTURE to its executable"]
async fn production_desktop_health_checks_do_not_cycle_the_connection() {
    let (_peer, pairing) = peer_on(0, "desktop");
    let (send, mut events) = mpsc::unbounded_channel();
    let client = Client::start(pairing, move |event| {
        eprintln!("desktop integration: {} {:?}", event.state, event.error);
        send.send(event).is_ok()
    })
    .unwrap();
    connected(&mut events).await;
    let revision = client.status().revision;
    for _ in 0..3 {
        client.check().await.unwrap();
        assert_eq!(
            client.status().revision,
            revision,
            "health check replaced a healthy desktop tunnel"
        );
    }
    // Cross two periodic heartbeat deadlines, with ordinary API traffic in between.
    for number in 0..5 {
        let id = format!("health-{number}");
        let mut request = api(&id, "/api/mobile/handshake", &[]);
        request.method = "GET".into();
        assert_eq!(client.request(request).await.unwrap().status, 200);
        while !client.read(&id).await.unwrap().is_empty() {}
        assert!(
            timeout(Duration::from_secs(9), events.recv())
                .await
                .is_err(),
            "healthy connection changed state"
        );
        assert_eq!(client.status().revision, revision);
    }
    client.close();
}
