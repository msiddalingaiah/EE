// The native side of Osprey: the web app in a window, plus the file access the browser can't
// give it for good (a folder chosen once stays usable, with no permission asked again on each
// start). The app calls these commands through src/app/native.ts; paths are plain OS paths.

use serde::Serialize;
use std::fs;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
struct Entry {
  name: String,
  dir: bool,
}

/// The files and folders in a folder.
#[tauri::command]
fn fs_list(path: String) -> Result<Vec<Entry>, String> {
  let mut out = Vec::new();
  for e in fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))? {
    let e = e.map_err(|e| e.to_string())?;
    out.push(Entry { name: e.file_name().to_string_lossy().into_owned(), dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false) });
  }
  Ok(out)
}

/// Make a folder (and any missing parents).
#[tauri::command]
fn fs_mkdir(path: String) -> Result<(), String> {
  fs::create_dir_all(&path).map_err(|e| format!("{path}: {e}"))
}

/// Whether a file exists (not a folder).
#[tauri::command]
fn fs_is_file(path: String) -> bool {
  fs::metadata(&path).map(|m| m.is_file()).unwrap_or(false)
}

/// A file's bytes, sent raw (no JSON).
#[tauri::command]
fn fs_read(path: String) -> Result<Response, String> {
  fs::read(&path).map(Response::new).map_err(|e| format!("{path}: {e}"))
}

/// Write a file: the bytes are the request's raw body, the path its "path" header
/// (percent-encoded). Written to a temporary file beside it, then renamed over it, so a
/// failed write never leaves half a file.
#[tauri::command]
fn fs_write(request: Request<'_>) -> Result<(), String> {
  let InvokeBody::Raw(data) = request.body() else { return Err("fs_write: expected raw bytes".into()) };
  let header = request.headers().get("path").ok_or("fs_write: no path")?.to_str().map_err(|e| e.to_string())?;
  let path = percent_decode(header)?;
  let tmp = format!("{path}.osprey-tmp");
  fs::write(&tmp, data).map_err(|e| format!("{path}: {e}"))?;
  fs::rename(&tmp, &path).map_err(|e| {
    let _ = fs::remove_file(&tmp);
    format!("{path}: {e}")
  })
}

fn percent_decode(s: &str) -> Result<String, String> {
  let b = s.as_bytes();
  let mut out = Vec::with_capacity(b.len());
  let mut i = 0;
  while i < b.len() {
    if b[i] == b'%' && i + 2 < b.len() {
      let hex = std::str::from_utf8(&b[i + 1..i + 3]).map_err(|e| e.to_string())?;
      out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
      i += 3;
    } else {
      out.push(b[i]);
      i += 1;
    }
  }
  String::from_utf8(out).map_err(|e| e.to_string())
}

/// Ask for a folder; None if cancelled.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle, title: String) -> Option<String> {
  app.dialog().file().set_title(title).blocking_pick_folder().map(|p| p.to_string())
}

/// Ask for files to open (one, or several), showing only the extensions given (no dots).
#[tauri::command]
async fn pick_files(app: tauri::AppHandle, title: String, filter: String, extensions: Vec<String>, multiple: bool, directory: Option<String>) -> Vec<String> {
  let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
  let mut d = app.dialog().file().set_title(title).add_filter(filter, &exts);
  if let Some(dir) = directory {
    d = d.set_directory(dir);
  }
  let picked = if multiple { d.blocking_pick_files().unwrap_or_default() } else { d.blocking_pick_file().into_iter().collect() };
  picked.into_iter().map(|p| p.to_string()).collect()
}

/// Ask where to save a file; None if cancelled.
#[tauri::command]
async fn pick_save(app: tauri::AppHandle, title: String, name: String, filter: String, extensions: Vec<String>, directory: Option<String>) -> Option<String> {
  let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
  let mut d = app.dialog().file().set_title(title).set_file_name(name).add_filter(filter, &exts);
  if let Some(dir) = directory {
    d = d.set_directory(dir);
  }
  d.blocking_save_file().map(|p| p.to_string())
}

/// The file the app was started with (double-clicking a project, or `osprey.exe x.osprey`).
#[tauri::command]
fn startup_file() -> Option<String> {
  std::env::args().skip(1).find(|a| !a.starts_with('-') && std::path::Path::new(a).is_file())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![fs_list, fs_mkdir, fs_is_file, fs_read, fs_write, pick_folder, pick_files, pick_save, startup_file])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
