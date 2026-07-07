import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { LogicalSize } from "@tauri-apps/api/dpi";

import { ICONS } from "./icons";
import { AudioController } from "./player";
import { Visualizer } from "./visualizer";
import { Playlist, fileTrack, youtubeTrack, Track } from "./playlist";
import {
  pickFolder,
  scanFolder,
  toAssetSrc,
  ytdlpAvailable,
  youtubeTitle,
  resolveYoutube,
} from "./backend";

// ---------- element refs ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $("app") as HTMLDivElement;
const playBtn = $("playBtn") as HTMLButtonElement;
const stopBtn = $("stopBtn") as HTMLButtonElement;
const repeatBtn = $("repeatBtn") as HTMLButtonElement;
const muteBtn = $("muteBtn") as HTMLButtonElement;
const volume = $("volume") as HTMLInputElement;
const seek = $("seek") as HTMLInputElement;
const curTime = $("curTime") as HTMLSpanElement;
const totTime = $("totTime") as HTMLSpanElement;
const waveCanvas = $("wave") as HTMLCanvasElement;
const npText = $("npText") as HTMLSpanElement;
const folderBtn = $("folderBtn") as HTMLButtonElement;
const folderSelect = $("folderSelect") as HTMLSelectElement;
const folderClear = $("folderClear") as HTMLButtonElement;
const ytInput = $("ytInput") as HTMLInputElement;
const ytAdd = $("ytAdd") as HTMLButtonElement;
const playlistEl = $("playlist") as HTMLUListElement;
const collapseBtn = $("collapseBtn") as HTMLButtonElement;
const minBtn = $("minBtn") as HTMLButtonElement;
const closeBtn = $("closeBtn") as HTMLButtonElement;
const resizeGrip = $("resize") as HTMLDivElement;
const toastEl = $("toast") as HTMLDivElement;

// ---------- core objects ----------
const audio = new AudioController();
const viz = new Visualizer(waveCanvas);
const pl = new Playlist(playlistEl);
const win = getCurrentWindow();

let ytReady = false;
ytdlpAvailable()
  .then((v) => {
    ytReady = v;
    if (v) repairBrokenTitles();
  })
  .catch(() => {});

/** Re-fetch titles that were saved garbled (contain U+FFFD) or never resolved. */
function repairBrokenTitles() {
  for (const t of pl.tracks) {
    if (t.source !== "youtube" || !t.url) continue;
    if (!t.title.includes("�") && t.title !== t.url) continue;
    youtubeTitle(t.url)
      .then((title) => {
        if (!title) return;
        const tk = pl.trackById(t.id);
        if (tk) {
          tk.title = title;
          pl.render();
          save();
        }
      })
      .catch(() => {});
  }
}

// ---------- helpers ----------
function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function fillRange(input: HTMLInputElement, color = "#ffcf33") {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.background = `linear-gradient(90deg, ${color} 0%, ${color} ${pct}%, var(--panel-3) ${pct}%, var(--panel-3) 100%)`;
}

const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const dirname = (p: string) => {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : p;
};
const AUDIO_EXTS = ["mp3", "wav", "m4a", "flac", "ogg", "oga", "aac", "opus", "wma", "mp4"];
const isAudioExt = (p: string) => AUDIO_EXTS.includes((p.split(".").pop() || "").toLowerCase());

const escHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

let toastTimer = 0;
function toast(msg: string, err = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle("err", err);
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.add("hidden"), 3400);
}

function updateMarquee(text: string) {
  npText.textContent = text;
  npText.classList.remove("scroll");
  npText.style.removeProperty("--marquee-duration");
  requestAnimationFrame(() => {
    const parent = npText.parentElement!;
    const textWidth = npText.scrollWidth;
    if (textWidth - parent.clientWidth > 6) {
      // 같은 텍스트 두 벌을 이어 붙여 -50% 이동 시 끊김 없이 반복
      npText.textContent = "";
      for (let i = 0; i < 2; i++) {
        const seg = document.createElement("span");
        seg.className = "marquee-seg";
        seg.textContent = text;
        npText.appendChild(seg);
      }
      const speed = 28; // px/s
      npText.style.setProperty(
        "--marquee-duration",
        `${(textWidth + 36) / speed}s`,
      );
      npText.classList.add("scroll");
    }
  });
}

// ---------- persistence ----------
const STORE_KEY = "mysong.tracks.v1";
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(pl.tracks));
  } catch {
    /* ignore */
  }
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) pl.setTracks(arr as Track[]);
  } catch {
    /* ignore */
  }
}

// ---------- folder filter dropdown ----------
function refreshFolders() {
  const cur = folderSelect.value;
  const folders = pl.folders();
  folderSelect.innerHTML =
    `<option value="">폴더 선택 (전체)</option>` +
    folders.map((f) => `<option value="${escHtml(f)}">${escHtml(basename(f))}</option>`).join("");
  if (folders.includes(cur)) folderSelect.value = cur;
  else {
    folderSelect.value = "";
    pl.setFilter("");
  }
}

// ---------- playback ----------
async function playTrack(id: string) {
  const t = pl.trackById(id);
  if (!t) return;
  pl.setCurrent(id);
  updateMarquee(t.title);
  try {
    if (t.source === "file" && t.path) {
      await audio.play(toAssetSrc(t.path));
    } else if (t.source === "youtube" && t.url) {
      if (!ytReady) {
        toast("yt-dlp가 필요합니다. 설치 후 다시 시도하세요.", true);
        return;
      }
      updateMarquee("불러오는 중…  " + t.title);
      const info = await resolveYoutube(t.url);
      if (info.title && t.title === t.url) {
        t.title = info.title;
        pl.render();
        save();
      }
      updateMarquee(t.title);
      await audio.play(info.url);
    }
  } catch (e: any) {
    updateMarquee(t.title);
    toast(typeof e === "string" ? e : e?.message || "재생할 수 없습니다", true);
  }
}

// ---------- repeat mode ----------
type Repeat = "once" | "one" | "all";
let repeat: Repeat = "once";
function updateRepeatBtn() {
  const map: Record<Repeat, string> = { once: ICONS.once, one: ICONS.repeatOne, all: ICONS.repeat };
  repeatBtn.innerHTML = map[repeat];
  repeatBtn.classList.toggle("active", repeat !== "once");
  repeatBtn.title =
    repeat === "once" ? "재생방법: 1회" : repeat === "one" ? "재생방법: 1곡 반복" : "재생방법: 여러곡 반복";
}
repeatBtn.addEventListener("click", () => {
  repeat = repeat === "once" ? "one" : repeat === "one" ? "all" : "once";
  updateRepeatBtn();
});

// ---------- audio callbacks ----------
audio.onState = (playing) => {
  playBtn.innerHTML = playing ? ICONS.pause : ICONS.play;
  viz.setPlaying(playing);
};
audio.onTime = (cur, dur) => {
  totTime.textContent = fmt(dur);
  curTime.textContent = fmt(cur);
  if (!userSeeking) {
    seek.value = String(Math.round((dur > 0 ? cur / dur : 0) * 1000));
    fillRange(seek);
  }
};
audio.onEnded = () => {
  if (repeat === "one") {
    if (pl.currentId) void playTrack(pl.currentId);
    return;
  }
  const nxt = pl.next(pl.currentId, repeat === "all");
  if (nxt) void playTrack(nxt.id);
  else {
    audio.stop();
    viz.setPlaying(false);
  }
};
audio.onError = (msg) => toast(msg, true);

// ---------- transport controls ----------
playBtn.addEventListener("click", () => {
  if (!audio.hasSrc) {
    const f = pl.first();
    if (f) void playTrack(f.id);
    return;
  }
  audio.toggle();
});
stopBtn.addEventListener("click", () => audio.stop());

// ---------- seek ----------
let userSeeking = false;
seek.addEventListener("input", () => {
  userSeeking = true;
  audio.seekFraction(Number(seek.value) / 1000);
  fillRange(seek);
});
seek.addEventListener("change", () => (userSeeking = false));
seek.addEventListener("pointerup", () => (userSeeking = false));

// ---------- volume / mute ----------
let muted = false;
let prevVol = 0.8;
function applyVolume(v: number) {
  audio.setVolume(v);
  viz.setVolume(v);
  muteBtn.innerHTML = v === 0 ? ICONS.muted : ICONS.volume;
  fillRange(volume);
}
volume.addEventListener("input", () => {
  muted = Number(volume.value) === 0;
  applyVolume(Number(volume.value));
});
muteBtn.addEventListener("click", () => {
  muted = !muted;
  if (muted) {
    prevVol = Number(volume.value) || 0.8;
    volume.value = "0";
  } else {
    volume.value = String(prevVol || 0.8);
  }
  applyVolume(Number(volume.value));
});

// ---------- folder import ----------
folderBtn.addEventListener("click", async () => {
  const dir = await pickFolder();
  if (!dir) return;
  const files = await scanFolder(dir).catch(() => []);
  if (!files.length) {
    toast("이 폴더에 오디오 파일이 없습니다", true);
    return;
  }
  pl.add(files.map((f) => fileTrack(f.path, f.name, dir)));
  refreshFolders();
  folderSelect.value = dir;
  pl.setFilter(dir);
});
folderSelect.addEventListener("change", () => pl.setFilter(folderSelect.value));
folderClear.addEventListener("click", () => {
  folderSelect.value = "";
  pl.setFilter("");
});

// ---------- youtube add ----------
async function addYoutube() {
  const url = ytInput.value.trim();
  if (!url) return;
  const t = youtubeTrack(url);
  pl.add([t]);
  ytInput.value = "";
  if (ytReady) {
    youtubeTitle(url)
      .then((title) => {
        const tk = pl.trackById(t.id);
        if (tk && title) {
          tk.title = title;
          pl.render();
          save();
        }
      })
      .catch(() => {});
  } else {
    toast("추가됨. 재생하려면 yt-dlp 설치가 필요합니다.", true);
  }
}
ytAdd.addEventListener("click", addYoutube);
ytInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void addYoutube();
  }
});

// ---------- playlist wiring ----------
pl.onPlay = (id) => void playTrack(id);
pl.onChange = () => {
  refreshFolders();
  save();
};

// ---------- window controls ----------
closeBtn.addEventListener("click", () => void win.close());
minBtn.addEventListener("click", () => void win.minimize());

const COMPACT_H = 214;
let collapsed = false;
let expandedH = 640;
collapseBtn.addEventListener("click", async () => {
  collapsed = !collapsed;
  app.classList.toggle("collapsed", collapsed);
  collapseBtn.textContent = collapsed ? "▸" : "▾";
  try {
    const factor = await win.scaleFactor();
    const cur = await win.innerSize();
    const w = cur.width / factor;
    const h = cur.height / factor;
    if (collapsed) {
      expandedH = h;
      await win.setSize(new LogicalSize(w, COMPACT_H));
    } else {
      await win.setSize(new LogicalSize(w, expandedH));
    }
  } catch {
    /* ignore */
  }
});

// Bottom-right resize grip
resizeGrip.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  void win.startResizeDragging("SouthEast" as any);
});

// ---------- OS file drop ----------
async function addPaths(paths: string[]) {
  const audioTracks: Track[] = [];
  const dirs: string[] = [];
  for (const p of paths) {
    if (isAudioExt(p)) audioTracks.push(fileTrack(p, basename(p), dirname(p)));
    else dirs.push(p);
  }
  if (audioTracks.length) pl.add(audioTracks);
  for (const d of dirs) {
    const files = await scanFolder(d).catch(() => []);
    if (files.length) pl.add(files.map((f) => fileTrack(f.path, f.name, d)));
  }
  if (!audioTracks.length && !dirs.length) toast("추가할 오디오가 없습니다", true);
  refreshFolders();
}

getCurrentWebview()
  .onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "enter" || p.type === "over") app.classList.add("file-drag");
    else if (p.type === "drop") {
      app.classList.remove("file-drag");
      void addPaths(p.paths);
    } else app.classList.remove("file-drag");
  })
  .catch(() => {});

// Stop the webview from navigating if a native drop slips through.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// ---------- init ----------
playBtn.innerHTML = ICONS.play;
stopBtn.innerHTML = ICONS.stop;
muteBtn.innerHTML = ICONS.volume;
updateRepeatBtn();
applyVolume(Number(volume.value));
fillRange(seek);
load();
refreshFolders();
