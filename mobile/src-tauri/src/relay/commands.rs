use crate::relay::{crypto, Client, Pairing, Request, ResponseHead, StateEvent};
use crate::relay_background as background;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tauri::{
    ipc::{Channel, Response},
    State,
};

#[derive(Default)]
struct Owner {
    current: Option<(String, Arc<Client>)>,
    retired: VecDeque<String>,
}
#[derive(Default)]
pub struct Relay(Mutex<Owner>);
impl Owner {
    fn retire(&mut self, id: String) {
        self.retired.push_back(id);
        if self.retired.len() > 128 {
            self.retired.pop_front();
        }
    }
}
impl Relay {
    fn client(&self, id: &str) -> Result<Arc<Client>, String> {
        let owner = self.0.lock().map_err(|_| "连接状态不可用")?;
        owner
            .current
            .as_ref()
            .filter(|(key, _)| key == id)
            .map(|(_, client)| client.clone())
            .ok_or_else(|| "连接已关闭".into())
    }
    pub fn resume(&self) {
        if let Ok(owner) = self.0.lock() {
            if let Some((_, client)) = &owner.current {
                client.resume();
            }
        }
    }
    pub fn shutdown(&self, app: &tauri::AppHandle) {
        if let Ok(mut owner) = self.0.lock() {
            if let Some((id, client)) = owner.current.take() {
                client.close();
                background::stop_later(app.clone(), id);
            }
        }
    }
}
#[tauri::command]
pub async fn relay_open(
    app: tauri::AppHandle,
    relay: State<'_, Relay>,
    connection_id: String,
    pairing: Pairing,
    on_state: Channel<StateEvent>,
) -> Result<String, String> {
    pairing.validate()?;
    if connection_id.is_empty() || connection_id.len() > 128 {
        return Err("连接标识无效".into());
    }
    {
        let owner = relay.0.lock().map_err(|_| "连接状态不可用")?;
        if owner.retired.contains(&connection_id) {
            return Err("连接已关闭".into());
        }
        if owner
            .current
            .as_ref()
            .is_some_and(|(id, _)| id == &connection_id)
        {
            return Err("连接标识重复".into());
        }
    }
    background::start(app.clone(), connection_id.clone()).await?;
    let mut owner = relay.0.lock().map_err(|_| "连接状态不可用")?;
    if owner.retired.contains(&connection_id) {
        background::stop_later(app.clone(), connection_id);
        return Err("连接已关闭".into());
    }
    if owner
        .current
        .as_ref()
        .is_some_and(|(id, _)| id == &connection_id)
    {
        return Err("连接标识重复".into());
    }
    let origin = crypto::origin(&pairing.connect_code);
    let callback_app = app.clone();
    let callback_id = connection_id.clone();
    let started = Client::start(pairing, move |state| {
        if state.state == "closed" {
            background::stop_later(callback_app.clone(), callback_id.clone());
        }
        // Delivery failure while the WebView is paused does not close the native connection.
        on_state.send(state).is_ok()
    });
    let client = match started {
        Ok(client) => Arc::new(client),
        Err(error) => {
            background::stop_later(app.clone(), connection_id);
            return Err(error);
        }
    };
    if let Some((old_id, old)) = owner.current.take() {
        old.close();
        background::stop_later(app.clone(), old_id.clone());
        owner.retire(old_id);
    }
    owner.current = Some((connection_id, client));
    Ok(origin)
}
#[tauri::command]
pub async fn relay_close(
    app: tauri::AppHandle,
    relay: State<'_, Relay>,
    connection_id: String,
) -> Result<(), String> {
    {
        let mut owner = relay.0.lock().map_err(|_| "连接状态不可用")?;
        if owner
            .current
            .as_ref()
            .is_some_and(|(id, _)| id == &connection_id)
        {
            if let Some((_, client)) = owner.current.take() {
                client.close();
            }
        }
        owner.retire(connection_id.clone());
    }
    background::stop(app, connection_id).await
}
#[tauri::command]
pub async fn relay_resume(relay: State<'_, Relay>, connection_id: String) -> Result<(), String> {
    relay.client(&connection_id)?.check().await
}
#[tauri::command]
pub fn relay_status(relay: State<'_, Relay>, connection_id: String) -> Result<StateEvent, String> {
    Ok(relay.client(&connection_id)?.status())
}
#[tauri::command]
pub async fn relay_request(
    relay: State<'_, Relay>,
    connection_id: String,
    request: Request,
) -> Result<ResponseHead, String> {
    relay.client(&connection_id)?.request(request).await
}
#[tauri::command]
pub async fn relay_read(
    relay: State<'_, Relay>,
    connection_id: String,
    request_id: String,
) -> Result<Response, String> {
    // Raw IPC bytes avoid JSON arrays/base64 and are pulled only when the UI consumes them.
    Ok(Response::new(
        relay.client(&connection_id)?.read(&request_id).await?,
    ))
}
#[tauri::command]
pub async fn relay_cancel(
    relay: State<'_, Relay>,
    connection_id: String,
    request_id: String,
) -> Result<(), String> {
    relay.client(&connection_id)?.cancel(&request_id).await;
    Ok(())
}
