// Thin wrappers around Tauri commands + asset URL conversion.
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface TrackFile {
  path: string;
  name: string;
}

export interface YtInfo {
  title: string;
  url: string;
}

/** Open the OS folder picker. Returns the chosen path or null. */
export async function pickFolder(): Promise<string | null> {
  const res = await open({ directory: true, multiple: false, title: "폴더 선택" });
  return typeof res === "string" ? res : null;
}

/** Scan a folder (recursively) for audio files. */
export function scanFolder(path: string): Promise<TrackFile[]> {
  return invoke<TrackFile[]>("scan_folder", { path });
}

/** Convert a local file path to a webview-loadable asset URL. */
export function toAssetSrc(path: string): string {
  return convertFileSrc(path);
}

/** Whether a yt-dlp binary is available on PATH. */
export function ytdlpAvailable(): Promise<boolean> {
  return invoke<boolean>("ytdlp_available");
}

/** Fast title lookup for a YouTube URL. */
export function youtubeTitle(url: string): Promise<string> {
  return invoke<string>("youtube_title", { url });
}

/** Resolve a YouTube URL to a fresh direct audio stream URL (+ title). */
export function resolveYoutube(url: string): Promise<YtInfo> {
  return invoke<YtInfo>("resolve_youtube", { url });
}
