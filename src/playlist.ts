// Playlist model + DOM rendering with drag-reorder, multi-select and delete.
import { ICONS } from "./icons";

export type Source = "file" | "youtube";

export interface Track {
  id: string;
  title: string;
  source: Source;
  path?: string; // local file path
  url?: string; // youtube page url
  folder?: string; // owning folder (for the folder filter)
}

function uid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "t" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function fileTrack(path: string, name: string, folder?: string): Track {
  return { id: uid(), title: name.replace(/\.[^.]+$/, ""), source: "file", path, folder };
}

export function youtubeTrack(url: string, title?: string): Track {
  return { id: uid(), title: title || url, source: "youtube", url };
}

export class Playlist {
  tracks: Track[] = [];
  currentId: string | null = null;

  private selected = new Set<string>();
  private anchorId: string | null = null;
  private filter = "";
  private root: HTMLUListElement;
  private dragIds: string[] = [];

  onPlay: (id: string) => void = () => {};
  onChange: () => void = () => {};

  constructor(root: HTMLUListElement) {
    this.root = root;
    this.bindEvents();
  }

  // ---- data ----
  add(items: Track[]) {
    const existing = new Set(
      this.tracks.map((t) => t.path || t.url).filter(Boolean) as string[]
    );
    for (const t of items) {
      const key = t.path || t.url;
      if (key && existing.has(key)) continue;
      if (key) existing.add(key);
      this.tracks.push(t);
    }
    this.render();
    this.onChange();
  }

  setTracks(items: Track[]) {
    this.tracks = items;
    this.render();
  }

  removeIds(ids: Iterable<string>) {
    const set = new Set(ids);
    if (set.size === 0) return;
    this.tracks = this.tracks.filter((t) => !set.has(t.id));
    for (const id of set) this.selected.delete(id);
    if (this.currentId && set.has(this.currentId)) this.currentId = null;
    this.render();
    this.onChange();
  }

  removeSelected() {
    if (this.selected.size) this.removeIds([...this.selected]);
  }

  trackById(id: string): Track | undefined {
    return this.tracks.find((t) => t.id === id);
  }

  setCurrent(id: string | null) {
    this.currentId = id;
    this.render();
  }

  setFilter(folder: string) {
    this.filter = folder;
    this.render();
  }

  folders(): string[] {
    const set = new Set<string>();
    for (const t of this.tracks) if (t.folder) set.add(t.folder);
    return [...set].sort();
  }

  private visible(): Track[] {
    if (!this.filter) return this.tracks;
    return this.tracks.filter((t) => t.folder === this.filter);
  }

  /** Next track after `id` in the visible order; wraps if `wrap`. */
  next(id: string | null, wrap: boolean): Track | null {
    const v = this.visible();
    if (v.length === 0) return null;
    const i = id ? v.findIndex((t) => t.id === id) : -1;
    if (i === -1) return v[0];
    if (i + 1 < v.length) return v[i + 1];
    return wrap ? v[0] : null;
  }

  prev(id: string | null): Track | null {
    const v = this.visible();
    if (v.length === 0) return null;
    const i = id ? v.findIndex((t) => t.id === id) : -1;
    if (i <= 0) return v[v.length - 1];
    return v[i - 1];
  }

  first(): Track | null {
    return this.visible()[0] ?? null;
  }

  // ---- rendering ----
  render() {
    const v = this.visible();
    if (v.length === 0) {
      this.root.innerHTML = `<div class="empty">목록이 비어 있습니다.<br/>파일을 끌어다 놓거나 <b>+폴더</b> / <b>YouTube URL</b>로 추가하세요.</div>`;
      return;
    }
    const html = v
      .map((t) => {
        const sel = this.selected.has(t.id) ? " selected" : "";
        const playing = t.id === this.currentId ? " playing" : "";
        const icon = t.id === this.currentId ? `<span class="row-icon">${ICONS.play}</span>` : "";
        const badge = t.source === "youtube" ? `<span class="row-badge">Y</span>` : "";
        return `<li class="row${sel}${playing}" data-id="${t.id}">
          <span class="row-handle" title="드래그로 이동">≡</span>
          ${icon}${badge}
          <span class="row-title" title="${escapeAttr(t.title)}">${escapeHtml(t.title)}</span>
          <button class="row-del" title="목록에서 삭제" data-del="${t.id}">✕</button>
        </li>`;
      })
      .join("");
    this.root.innerHTML = html;
  }

  // ---- events ----
  private bindEvents() {
    // Selection + play
    this.root.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const del = target.closest<HTMLElement>("[data-del]");
      if (del) {
        this.removeIds([del.dataset.del!]);
        e.stopPropagation();
        return;
      }
      const row = target.closest<HTMLElement>(".row");
      if (!row) return;
      if (target.closest(".row-handle")) return; // handle is for dragging only
      const id = row.dataset.id!;
      if (target.closest(".row-icon")) {
        this.onPlay(id);
        return;
      }
      this.handleSelect(id, e);
      // Plain click (no modifier) starts playback immediately.
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) this.onPlay(id);
    });

    this.root.addEventListener("dblclick", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".row");
      if (row) this.onPlay(row.dataset.id!);
    });

    // Keyboard: Delete / Ctrl+A / Enter
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.removeSelected();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        this.selected = new Set(this.visible().map((t) => t.id));
        this.render();
      } else if (e.key === "Enter") {
        const firstSel = this.visible().find((t) => this.selected.has(t.id));
        if (firstSel) this.onPlay(firstSel.id);
      }
    });

    // Pointer-based drag reorder via the ≡ handle.
    // (HTML5 DnD is unavailable: Tauri's OS drag-drop handler intercepts it.)
    this.root.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const handle = (e.target as HTMLElement).closest<HTMLElement>(".row-handle");
      if (!handle) return;
      const row = handle.closest<HTMLElement>(".row")!;
      const id = row.dataset.id!;
      if (!this.selected.has(id)) {
        this.selected = new Set([id]);
        this.anchorId = id;
        this.render();
      }
      // Preserve visible order of the dragged set.
      this.dragIds = this.visible()
        .filter((t) => this.selected.has(t.id))
        .map((t) => t.id);
      e.preventDefault();

      const markDragging = () => {
        this.root.querySelectorAll(".row").forEach((r) => {
          r.classList.toggle(
            "dragging",
            this.dragIds.includes((r as HTMLElement).dataset.id!)
          );
        });
      };
      markDragging();

      const rowAt = (x: number, y: number) =>
        document.elementFromPoint(x, y)?.closest<HTMLElement>(".row") ?? null;

      const onMove = (ev: PointerEvent) => {
        this.clearDropMarks();
        const over = rowAt(ev.clientX, ev.clientY);
        if (!over) return;
        const rect = over.getBoundingClientRect();
        const after = ev.clientY > rect.top + rect.height / 2;
        over.classList.add(after ? "drop-after" : "drop-before");
      };
      const onUp = (ev: PointerEvent) => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        const over = rowAt(ev.clientX, ev.clientY);
        if (over && this.dragIds.length) {
          const rect = over.getBoundingClientRect();
          const after = ev.clientY > rect.top + rect.height / 2;
          this.moveIds(this.dragIds, over.dataset.id!, after);
        }
        this.finishDrag();
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
  }

  private handleSelect(id: string, e: MouseEvent) {
    if (e.shiftKey && this.anchorId) {
      const v = this.visible();
      const a = v.findIndex((t) => t.id === this.anchorId);
      const b = v.findIndex((t) => t.id === id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        this.selected = new Set(v.slice(lo, hi + 1).map((t) => t.id));
      }
    } else if (e.ctrlKey || e.metaKey) {
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
      this.anchorId = id;
    } else {
      this.selected = new Set([id]);
      this.anchorId = id;
    }
    this.render();
  }

  private moveIds(ids: string[], targetId: string, after: boolean) {
    const set = new Set(ids);
    if (set.has(targetId)) return; // dropped onto the dragged block itself
    const moving = this.tracks.filter((t) => set.has(t.id));
    const rest = this.tracks.filter((t) => !set.has(t.id));
    let idx = rest.findIndex((t) => t.id === targetId);
    if (idx === -1) idx = rest.length - 1;
    const insertAt = after ? idx + 1 : idx;
    rest.splice(insertAt, 0, ...moving);
    this.tracks = rest;
    this.render();
    this.onChange();
  }

  private clearDropMarks() {
    this.root
      .querySelectorAll(".drop-before,.drop-after")
      .forEach((r) => r.classList.remove("drop-before", "drop-after"));
  }

  private finishDrag() {
    this.clearDropMarks();
    this.root.querySelectorAll(".dragging").forEach((r) => r.classList.remove("dragging"));
    this.dragIds = [];
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
