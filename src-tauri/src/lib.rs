use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

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

/// Directory holding downloaded YouTube audio. `-v2` marks the download recipe;
/// bump it when the recipe changes so stale files are re-fetched.
fn cache_dir() -> PathBuf {
    std::env::temp_dir().join("mysong-cache-v2")
}

// A tiny localhost HTTP server that streams cached audio files with Range
// support. The webview's asset protocol (`convertFileSrc`) fails to hand very
// large files (multi-hour YouTube audio) to WebKit — it reports "operation not
// supported" — whereas WebKit's ordinary HTTP media loader streams them fine
// and fetches only the byte ranges it needs (so seeking works at any length).
static MEDIA_PORT: OnceLock<u16> = OnceLock::new();

/// Start the media server once and return its port. Serves files from
/// `cache_dir()` only, by bare file name.
fn ensure_media_server() -> u16 {
    *MEDIA_PORT.get_or_init(|| {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("bind media server");
        let port = server
            .server_addr()
            .to_ip()
            .expect("media server addr")
            .port();
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                std::thread::spawn(move || {
                    let _ = serve_media(req);
                });
            }
        });
        port
    })
}

fn header(k: &str, v: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

/// Serve one request: `GET /<name>` streams `cache_dir()/<name>`, honoring a
/// `Range` header (206 + Content-Range). Only plain file names are accepted.
fn serve_media(req: tiny_http::Request) -> std::io::Result<()> {
    let cors = header("Access-Control-Allow-Origin", "*");
    let name = req
        .url()
        .trim_start_matches('/')
        .split('?')
        .next()
        .unwrap_or("")
        .to_string();
    if name.is_empty() || name.contains('/') || name.contains("..") {
        return req.respond(tiny_http::Response::empty(404).with_header(cors));
    }
    let path = cache_dir().join(&name);
    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return req.respond(tiny_http::Response::empty(404).with_header(cors)),
    };
    let total = file.metadata()?.len();
    let ctype = header("Content-Type", "audio/mp4");
    let accept = header("Accept-Ranges", "bytes");

    let range = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());

    if let Some(spec) = range.as_deref().and_then(|r| r.strip_prefix("bytes=")) {
        let mut parts = spec.splitn(2, '-');
        let start: u64 = parts.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        let end: u64 = parts
            .next()
            .filter(|s| !s.trim().is_empty())
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(total.saturating_sub(1))
            .min(total.saturating_sub(1));
        if total == 0 || start > end {
            let cr = header("Content-Range", &format!("bytes */{total}"));
            return req.respond(
                tiny_http::Response::empty(416)
                    .with_header(cors)
                    .with_header(cr),
            );
        }
        let len = end - start + 1;
        file.seek(SeekFrom::Start(start))?;
        let cr = header("Content-Range", &format!("bytes {start}-{end}/{total}"));
        let resp = tiny_http::Response::new(
            tiny_http::StatusCode(206),
            vec![cors, ctype, accept, cr],
            file.take(len),
            Some(len as usize),
            None,
        );
        return req.respond(resp);
    }

    let resp = tiny_http::Response::new(
        tiny_http::StatusCode(200),
        vec![cors, ctype, accept],
        file,
        Some(total as usize),
        None,
    );
    req.respond(resp)
}

/// Resolve a bundled helper binary by base name (`yt-dlp`, `ffmpeg`, …).
/// Prefer the copy bundled with the app (works with no system install), then
/// fall back to the bare name so the OS resolves it on PATH. Returns the full
/// path when a bundled copy is found, otherwise the bare (PATH) name.
fn resolve_binary(base: &str) -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    let name = format!("{base}.exe");
    #[cfg(not(target_os = "windows"))]
    let name = base.to_string();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // `tauri build` places declared resources next to the binary, either
            // directly or under a `resources/` subfolder (Windows/Linux). On
            // macOS they land in the app bundle's `Contents/Resources/` instead
            // (exe is in `Contents/MacOS/`), so also probe one level up.
            let mut cands = vec![dir.join("resources").join(&name), dir.join(&name)];
            #[cfg(target_os = "macos")]
            if let Some(contents) = dir.parent() {
                cands.push(contents.join("Resources").join("resources").join(&name));
                cands.push(contents.join("Resources").join(&name));
            }
            for cand in cands {
                if cand.is_file() {
                    return cand;
                }
            }
        }
    }
    std::path::PathBuf::from(name)
}

fn ytdlp_program() -> std::ffi::OsString {
    resolve_binary("yt-dlp").into_os_string()
}

/// Full path to a usable ffmpeg, if one is bundled. Passed to yt-dlp via
/// `--ffmpeg-location` so its FixupM4a step can rewrite the fragmented DASH
/// audio YouTube serves into a single-`moov` (seekable) m4a. Returns None when
/// no bundled copy exists — then yt-dlp falls back to any ffmpeg on PATH.
fn ffmpeg_location() -> Option<std::ffi::OsString> {
    let p = resolve_binary("ffmpeg");
    p.is_file().then(|| p.into_os_string())
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
    url: String,
}

/// Download a YouTube URL's audio (m4a/AAC) to a temp cache file and return a
/// localhost HTTP URL for it. Served over HTTP (not the asset protocol) so
/// WebKit streams even very long files with Range requests — the asset protocol
/// fails on large files, and googlevideo can't be streamed directly (no CORS,
/// WebM/Opus rejected). yt-dlp caches by id, so replays reuse the file.
#[tauri::command]
fn download_youtube(url: String) -> Result<YtFile, String> {
    let dir = cache_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("캐시 폴더 생성 실패: {e}"))?;
    let tmpl = dir.join("%(id)s.%(ext)s");
    let tmpl = tmpl.to_str().ok_or("캐시 경로 오류")?;
    let mut cmd = ytdlp();
    cmd.args([
        // m4a/AAC container downloads directly, no re-encode needed.
        "-f",
        "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/best[ext=m4a]/bestaudio/best",
        "--no-playlist",
        "--no-overwrites",
        "-o",
        tmpl,
        "--print",
        "after_move:%(title)s\t%(filepath)s",
    ]);
    // With ffmpeg, yt-dlp's FixupM4a rewrites YouTube's fragmented (moof-based)
    // DASH audio into a single-`moov` m4a. Without it, long videos have no seek
    // index and seeking produces silence — audio plays but scrubbing fails.
    if let Some(ff) = ffmpeg_location() {
        cmd.arg("--ffmpeg-location").arg(ff);
    }
    cmd.arg(&url);
    let out = cmd
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
    let path = path.trim();
    let fname = Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .ok_or("오디오 파일을 찾지 못했습니다")?;
    let port = ensure_media_server();
    Ok(YtFile {
        title: title.trim().to_string(),
        url: format!("http://127.0.0.1:{port}/{fname}"),
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
