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
    "mp3", "wav", "m4a", "flac", "ogg", "oga", "aac", "opus", "mp4", "webm", "weba",
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

/// Resolve the yt-dlp binary. Prefer the copy bundled with the app (so it works
/// with no system install and survives antivirus blocking of network installs),
/// then fall back to `yt-dlp` on PATH.
fn ytdlp_program() -> std::ffi::OsString {
    #[cfg(target_os = "windows")]
    let name = "yt-dlp.exe";
    #[cfg(not(target_os = "windows"))]
    let name = "yt-dlp";

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // `tauri build` places declared resources next to the binary, either
            // directly or under a `resources/` subfolder (Windows/Linux). On
            // macOS they land in the app bundle's `Contents/Resources/` instead
            // (exe is in `Contents/MacOS/`), so also probe one level up.
            let mut cands = vec![dir.join("resources").join(name), dir.join(name)];
            #[cfg(target_os = "macos")]
            if let Some(contents) = dir.parent() {
                cands.push(contents.join("Resources").join("resources").join(name));
                cands.push(contents.join("Resources").join(name));
            }
            for cand in cands {
                if cand.is_file() {
                    return cand.into_os_string();
                }
            }
        }
    }
    name.into()
}

fn ytdlp() -> Command {
    let mut c = Command::new(ytdlp_program());
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
            // Prefer m4a/AAC: macOS WebKit (the webview) cannot decode WebM/Opus,
            // which `bestaudio` otherwise picks — playback aborts. AAC plays on
            // both macOS WebKit and Windows WebView2.
            "-f",
            "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/best[ext=m4a]/bestaudio/best",
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
pub struct YtFile {
    title: String,
    path: String,
}

/// Download a YouTube URL's audio (m4a/AAC) to a temp cache file and return its
/// local path. Played from disk via the asset protocol — the webview cannot
/// stream googlevideo directly (no CORS header, and WebKit rejects WebM/Opus).
/// yt-dlp caches by id, so replays reuse the file.
#[tauri::command]
fn download_youtube(url: String) -> Result<YtFile, String> {
    let dir = std::env::temp_dir().join("mysong-cache");
    std::fs::create_dir_all(&dir).map_err(|e| format!("캐시 폴더 생성 실패: {e}"))?;
    let tmpl = dir.join("%(id)s.%(ext)s");
    let tmpl = tmpl.to_str().ok_or("캐시 경로 오류")?;
    let out = ytdlp()
        .args([
            // m4a/AAC container downloads directly, no ffmpeg re-encode needed.
            "-f",
            "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/best[ext=m4a]/bestaudio/best",
            "--no-playlist",
            "--no-overwrites",
            "-o",
            tmpl,
            "--print",
            "after_move:%(title)s\t%(filepath)s",
            &url,
        ])
        .output()
        .map_err(|e| format!("yt-dlp 실행 실패: {e}"))?;
    if !out.status.success() {
        return Err(last_err_line(&out.stderr));
    }
    let text = decode_out(&out.stdout);
    let line = text
        .lines()
        .rev()
        .find(|l| l.contains('\t'))
        .ok_or("다운로드 결과를 확인하지 못했습니다")?;
    let (title, path) = line.split_once('\t').unwrap();
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("오디오 파일을 찾지 못했습니다".into());
    }
    Ok(YtFile {
        title: title.trim().to_string(),
        path,
    })
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

/// Store a secret in the OS credential store (Windows Credential Manager,
/// DPAPI-protected). An empty value deletes the entry.
#[tauri::command]
fn secret_set(name: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new("MySong", &name).map_err(|e| e.to_string())?;
    if value.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(&value).map_err(|e| e.to_string())
}

/// Read a secret from the OS credential store ("" if absent).
#[tauri::command]
fn secret_get(name: String) -> Result<String, String> {
    let entry = keyring::Entry::new("MySong", &name).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => Ok(v),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Open a URL in the default browser (https only).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("https URL만 열 수 있습니다".into());
    }
    #[cfg(target_os = "windows")]
    {
        let mut c = Command::new("cmd");
        c.args(["/C", "start", "", &url]).creation_flags(CREATE_NO_WINDOW);
        c.spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("open").arg(&url).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
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
            download_youtube,
            youtube_search,
            open_url,
            secret_set,
            secret_get
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
