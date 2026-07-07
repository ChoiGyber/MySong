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

  // ---- fade helpers ----
  private baseVolume = 0.8;
  private fadeToken = 0;

  /** Animate element volume toward `target` over `ms`. Resolves when done or superseded. */
  private fade(target: number, ms: number): Promise<void> {
    const token = ++this.fadeToken;
    const from = this.el.volume;
    if (ms <= 0 || from === target) {
      this.el.volume = target;
      return Promise.resolve();
    }
    const t0 = performance.now();
    return new Promise((resolve) => {
      const step = (now: number) => {
        if (token !== this.fadeToken) return resolve(); // superseded
        const k = Math.min(1, (now - t0) / ms);
        this.el.volume = from + (target - from) * k;
        if (k < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  private async fadeOutThen(fn: () => void, ms = 320): Promise<void> {
    if (!this.el.paused && this.el.src) await this.fade(0, ms);
    fn();
    this.el.volume = this.baseVolume;
  }

  async play(src: string): Promise<void> {
    // Fade out whatever is playing before switching tracks.
    if (!this.el.paused && this.el.src) await this.fade(0, 220);
    this.el.src = src;
    this.el.volume = 0;
    try {
      await this.el.play();
      void this.fade(this.baseVolume, 420);
    } catch (e) {
      this.el.volume = this.baseVolume;
      this.onError("재생을 시작할 수 없습니다");
      throw e;
    }
  }

  toggle(): void {
    if (!this.el.src) return;
    if (this.el.paused) {
      this.el.volume = 0;
      void this.el.play().then(() => this.fade(this.baseVolume, 420)).catch(() => {});
    } else {
      void this.fadeOutThen(() => this.el.pause());
    }
  }

  pause(): void {
    void this.fadeOutThen(() => this.el.pause());
  }

  stop(): void {
    void this.fadeOutThen(() => {
      this.el.pause();
      try {
        this.el.currentTime = 0;
      } catch {
        /* ignore */
      }
      this.onState(false);
      this.onTime(0, this.dur);
    });
  }

  seekFraction(f: number): void {
    if (this.dur > 0) this.el.currentTime = Math.max(0, Math.min(1, f)) * this.dur;
  }

  setVolume(v: number): void {
    this.baseVolume = Math.max(0, Math.min(1, v));
    this.fadeToken++; // cancel any running fade
    this.el.volume = this.baseVolume;
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
