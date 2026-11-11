use tauri::AppHandle;

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use tauri::{
        plugin::{Builder, PluginHandle, TauriPlugin},
        Manager, Runtime,
    };

    struct Background<R: Runtime>(PluginHandle<R>);
    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("relay-background")
            .setup(|app, api| {
                let handle =
                    api.register_android_plugin("app.loopra.mobile", "RelayBackgroundPlugin")?;
                app.manage(Background(handle));
                Ok(())
            })
            .build()
    }
    pub async fn call(
        app: AppHandle,
        command: &'static str,
        connection_id: String,
    ) -> Result<(), String> {
        let background = app.state::<Background<tauri::Wry>>();
        background
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                command,
                serde_json::json!({"connectionId":connection_id}),
            )
            .await
            .map(|_| ())
            .map_err(|error| format!("后台连接服务{command}失败：{error}"))
    }
}
#[cfg(target_os = "android")]
pub use android::init;

pub async fn start(app: AppHandle, connection_id: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    return android::call(app, "start", connection_id).await;
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, connection_id);
        Ok(())
    }
}
pub async fn stop(app: AppHandle, connection_id: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    return android::call(app, "stop", connection_id).await;
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, connection_id);
        Ok(())
    }
}
pub fn stop_later(app: AppHandle, connection_id: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = stop(app, connection_id).await {
            eprintln!("{error}");
        }
    });
}
