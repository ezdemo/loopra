use loopra_relay as relay;
#[path = "relay/background.rs"]
mod relay_background;
#[path = "relay/commands.rs"]
mod relay_commands;
use relay::Pairing;
use relay_commands::*;
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::Manager;

fn pairing_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("pairing.json"))
        .map_err(|_| "无法访问应用数据目录".into())
}

#[tauri::command]
fn load_pairing(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
) -> Result<Option<Pairing>, String> {
    let _guard = lock.lock().map_err(|_| "配对存储不可用")?;
    match fs::read(pairing_path(&app)?) {
        Ok(raw) => serde_json::from_slice(&raw)
            .map(Some)
            .map_err(|_| "保存的配对信息已损坏，请重新配对".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("读取配对信息失败".into()),
    }
}

#[tauri::command]
fn save_pairing(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
    pairing: Pairing,
) -> Result<(), String> {
    pairing.validate()?;
    let _guard = lock.lock().map_err(|_| "配对存储不可用")?;
    let path = pairing_path(&app)?;
    fs::create_dir_all(path.parent().ok_or("配对路径无效")?).map_err(|_| "创建配对目录失败")?;
    let raw = serde_json::to_vec(&pairing).map_err(|_| "配对信息编码失败")?;
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, raw).map_err(|_| "保存配对信息失败")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|_| "设置配对文件权限失败")?;
    }
    fs::rename(temporary, path).map_err(|_| "更新配对信息失败".into())
}

#[tauri::command]
fn clear_pairing(app: tauri::AppHandle, lock: tauri::State<'_, Mutex<()>>) -> Result<(), String> {
    let _guard = lock.lock().map_err(|_| "配对存储不可用")?;
    match fs::remove_file(pairing_path(&app)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("清除配对信息失败".into()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(Mutex::new(()))
        .manage(Relay::default())
        .invoke_handler(tauri::generate_handler![
            load_pairing,
            save_pairing,
            clear_pairing,
            relay_open,
            relay_close,
            relay_resume,
            relay_status,
            relay_request,
            relay_read,
            relay_cancel
        ]);
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(relay_background::init());
    builder
        .build(tauri::generate_context!())
        .expect("failed to start Loopra")
        .run(|app, event| match event {
            tauri::RunEvent::Resumed => app.state::<Relay>().resume(),
            tauri::RunEvent::Exit => app.state::<Relay>().shutdown(app),
            _ => {}
        });
}
