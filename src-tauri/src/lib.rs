use std::fs;
use std::path::Path;
use std::process::Command;

use serde::Serialize;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Audio file extensions we treat as playable tracks.
const AUDIO_EXTS: &[&str] = &[
    "mp3", "wav", "m4a", "flac", "ogg", "oga", "aac", "opus", "wma", "mp4",
];

#[derive(Serialize)]
pub struct TrackFile {
    path: String,
    name: String,
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Recursively collect audio files under `dir` (bounded depth to stay responsive).
fn scan_dir(dir: &Path, out: &mut Vec<TrackFile>, depth: usize) {
    if depth > 8 || out.len() > 20_000 {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            scan_dir(&p, out, depth + 1);
        } else if is_audio(&p) {
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            out.push(TrackFile {
                path: p.to_string_lossy().to_string(),
                name,
            });
        }
    }
}

/// Scan a folder for audio files, returned sorted by file name.
#[tauri::command]
fn scan_folder(path: String) -> Vec<TrackFile> {
    let mut out = Vec::new();
    scan_dir(Path::new(&path), &mut out, 0);
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

fn ytdlp() -> Command {
    let mut c = Command::new("yt-dlp");
    // Force UTF-8 output; otherwise Windows pipes use the locale codepage
    // (e.g. CP949) and non-ASCII titles arrive garbled.
    c.env("PYTHONIOENCODING", "utf-8");
    #[cfg(target_os = "windows")]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// True if a `yt-dlp` binary is reachable on PATH.
#[tauri::command]
fn ytdlp_available() -> bool {
    ytdlp()
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Decode child-process output: prefer UTF-8, fall back to the Korean
/// locale codepage (CP949/EUC-KR) when the bytes are not valid UTF-8.
fn decode_out(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let (s, _, _) = encoding_rs::EUC_KR.decode(bytes);
            s.into_owned()
        }
    }
}

/// Just the video title — fast, used to label a freshly added YouTube URL.
#[tauri::command]
fn youtube_title(url: String) -> Result<String, String> {
    let out = ytdlp()
        .args(["--no-playlist", "--skip-download", "--get-title", &url])
        .output()
        .map_err(|e| format!("yt-dlp 실행 실패: {e}"))?;
    if !out.status.success() {
        return Err(last_err_line(&out.stderr));
    }
    let title = decode_out(&out.stdout).trim().to_string();
    if title.is_empty() {
        return Err("제목을 가져오지 못했습니다".into());
    }
    Ok(title)
}

#[derive(Serialize)]
pub struct YtInfo {
    title: String,
    url: String,
}

/// Resolve a YouTube page URL to a direct best-audio stream URL (+ title).
/// Called at play time because these URLs expire.
#[tauri::command]
fn resolve_youtube(url: String) -> Result<YtInfo, String> {
    let out = ytdlp()
        .args([
            "-f",
            "bestaudio/best",
            "--no-playlist",
            "--get-title",
            "--get-url",
            &url,
        ])
        .output()
        .map_err(|e| format!("yt-dlp 실행 실패: {e}"))?;
    if !out.status.success() {
        return Err(last_err_line(&out.stderr));
    }
    let text = decode_out(&out.stdout);
    let title = text
        .lines()
        .find(|l| !l.trim().is_empty() && !l.starts_with("http"))
        .unwrap_or("YouTube")
        .trim()
        .to_string();
    let media = text
        .lines()
        .rev()
        .find(|l| l.starts_with("http"))
        .unwrap_or("")
        .trim()
        .to_string();
    if media.is_empty() {
        return Err("오디오 스트림을 찾지 못했습니다".into());
    }
    Ok(YtInfo { title, url: media })
}

#[derive(Serialize)]
pub struct YtSearchItem {
    title: String,
    url: String,
}

/// Search YouTube for `query` and return the first matching video.
#[tauri::command]
fn youtube_search(query: String) -> Result<YtSearchItem, String> {
    let out = ytdlp()
        .args([
            "--flat-playlist",
            "--print",
            "%(id)s\t%(title)s",
            &format!("ytsearch1:{query}"),
        ])
        .output()
        .map_err(|e| format!("yt-dlp 실행 실패: {e}"))?;
    if !out.status.success() {
        return Err(last_err_line(&out.stderr));
    }
    let text = decode_out(&out.stdout);
    let line = text
        .lines()
        .find(|l| l.contains('\t'))
        .ok_or("검색 결과가 없습니다")?;
    let (id, title) = line.split_once('\t').unwrap();
    Ok(YtSearchItem {
        title: title.trim().to_string(),
        url: format!("https://www.youtube.com/watch?v={}", id.trim()),
    })
}

fn last_err_line(stderr: &[u8]) -> String {
    let s = decode_out(stderr);
    let line = s
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("알 수 없는 오류");
    format!("yt-dlp: {}", line.trim())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            ytdlp_available,
            youtube_title,
            resolve_youtube,
            youtube_search
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
