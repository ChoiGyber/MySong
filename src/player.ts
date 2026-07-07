// Audio playback wrapper around a single <audio> element.
// Handles both local files (asset: URLs) and remote streams (https YouTube audio).

export class AudioController {
  readonly el: HTMLAudioElement;

  onTime: (cur: number, dur: number) => void = () => {};
  onEnded: () => void = () => {};
  onState: (playing: boolean) => void = () => {};
  onError: (msg: string) => void = () => {};

  constructor() {
    this.el = new Audio();
    this.el.preload = "auto";
    this.el.volume = 0.8;

    this.el.addEventListener("timeupdate", () =>
      this.onTime(this.el.currentTime, this.dur)
    );
    this.el.addEventListener("durationchange", () =>
      this.onTime(this.el.currentTime, this.dur)
    );
    this.el.addEventListener("loadedmetadata", () =>
      this.onTime(this.el.currentTime, this.dur)
    );
    this.el.addEventListener("play", () => this.onState(true));
    this.el.addEventListener("playing", () => this.onState(true));
    this.el.addEventListener("pause", () => this.onState(false));
    this.el.addEventListener("ended", () => this.onEnded());
    this.el.addEventListener("error", () => {
      if (this.el.src) this.onError("재생할 수 없는 파일입니다");
    });
  }

  private get dur(): number {
    const d = this.el.duration;
    return Number.isFinite(d) ? d : 0;
  }

  async play(src: string): Promise<void> {
    this.el.src = src;
    try {
      await this.el.play();
    } catch (e) {
      this.onError("재생을 시작할 수 없습니다");
      throw e;
    }
  }

  toggle(): void {
    if (!this.el.src) return;
    if (this.el.paused) void this.el.play().catch(() => {});
    else this.el.pause();
  }

  pause(): void {
    this.el.pause();
  }

  stop(): void {
    this.el.pause();
    try {
      this.el.currentTime = 0;
    } catch {
      /* ignore */
    }
    this.onState(false);
    this.onTime(0, this.dur);
  }

  seekFraction(f: number): void {
    if (this.dur > 0) this.el.currentTime = Math.max(0, Math.min(1, f)) * this.dur;
  }

  setVolume(v: number): void {
    this.el.volume = Math.max(0, Math.min(1, v));
  }

  setMuted(m: boolean): void {
    this.el.muted = m;
  }

  get paused(): boolean {
    return this.el.paused;
  }

  get hasSrc(): boolean {
    return !!this.el.src;
  }
}
