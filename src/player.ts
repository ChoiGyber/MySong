// Audio playback wrapper.
//
// Two <audio> elements are kept:
//  - `el`   : primary, routed through Web Audio (AnalyserNode) for a real
//             frequency spectrum. Requires the source to allow CORS
//             (crossOrigin="anonymous"), which Tauri's asset protocol and
//             YouTube's googlevideo streams both do.
//  - `fbEl` : plain fallback with direct output. Used when a source refuses
//             CORS — playback still works, the visualizer just falls back
//             to its simulated mode (spectrum() returns null).

export class AudioController {
  readonly el: HTMLAudioElement;
  private fbEl: HTMLAudioElement;
  private active: HTMLAudioElement;

  private actx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private freq: Uint8Array<ArrayBuffer> | null = null;
  private usingAnalyser = false;

  onTime: (cur: number, dur: number) => void = () => {};
  onEnded: () => void = () => {};
  onState: (playing: boolean) => void = () => {};
  onError: (msg: string) => void = () => {};

  constructor() {
    this.el = new Audio();
    this.el.crossOrigin = "anonymous";
    this.fbEl = new Audio();
    this.active = this.el;
    for (const el of [this.el, this.fbEl]) {
      el.preload = "auto";
      el.volume = 0.8;
      this.bind(el);
    }
  }

  private bind(el: HTMLAudioElement) {
    const ifActive = (fn: () => void) => () => {
      if (el === this.active) fn();
    };
    el.addEventListener("timeupdate", ifActive(() => this.onTime(el.currentTime, this.dur)));
    el.addEventListener("durationchange", ifActive(() => this.onTime(el.currentTime, this.dur)));
    el.addEventListener("loadedmetadata", ifActive(() => this.onTime(el.currentTime, this.dur)));
    el.addEventListener("play", ifActive(() => this.onState(true)));
    el.addEventListener("playing", ifActive(() => this.onState(true)));
    el.addEventListener("pause", ifActive(() => this.onState(false)));
    el.addEventListener("ended", ifActive(() => this.onEnded()));
  }

  private get dur(): number {
    const d = this.active.duration;
    return Number.isFinite(d) ? d : 0;
  }

  // ---- Web Audio analyser ----
  private ensureAnalyser() {
    if (!this.actx) {
      this.actx = new AudioContext();
      const src = this.actx.createMediaElementSource(this.el);
      this.analyser = this.actx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.75;
      src.connect(this.analyser);
      this.analyser.connect(this.actx.destination);
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    }
    if (this.actx.state === "suspended") void this.actx.resume();
  }

  /**
   * Real frequency spectrum as `bands` values in 0..1, log-spaced 40Hz–16kHz
   * (low → high). Returns null when unavailable (fallback element active,
   * nothing playing yet) so callers can use a simulated display instead.
   */
  spectrum(bands: number): number[] | null {
    if (!this.usingAnalyser || !this.analyser || !this.freq || !this.actx) return null;
    this.analyser.getByteFrequencyData(this.freq);
    const n = this.freq.length;
    const ny = this.actx.sampleRate / 2;
    const fmin = 40;
    const fmax = Math.min(16000, ny);
    const out = new Array<number>(bands);
    for (let i = 0; i < bands; i++) {
      const f0 = fmin * Math.pow(fmax / fmin, i / bands);
      const f1 = fmin * Math.pow(fmax / fmin, (i + 1) / bands);
      const b0 = Math.max(0, Math.floor((f0 / ny) * n));
      const b1 = Math.min(n - 1, Math.max(b0, Math.ceil((f1 / ny) * n)));
      let sum = 0;
      for (let b = b0; b <= b1; b++) sum += this.freq[b];
      out[i] = sum / (b1 - b0 + 1) / 255;
    }
    return out;
  }

  // ---- fade helpers ----
  private baseVolume = 0.8;
  private fadeToken = 0;

  /** Animate element volume toward `target` over `ms`. Resolves when done or superseded. */
  private fade(target: number, ms: number): Promise<void> {
    const token = ++this.fadeToken;
    const el = this.active;
    const from = el.volume;
    if (ms <= 0 || from === target) {
      el.volume = target;
      return Promise.resolve();
    }
    const t0 = performance.now();
    return new Promise((resolve) => {
      const step = (now: number) => {
        if (token !== this.fadeToken) return resolve(); // superseded
        const k = Math.min(1, (now - t0) / ms);
        el.volume = from + (target - from) * k;
        if (k < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  private async fadeOutThen(fn: () => void, ms = 320): Promise<void> {
    if (!this.active.paused && this.active.src) await this.fade(0, ms);
    fn();
    this.active.volume = this.baseVolume;
  }

  private setActive(el: HTMLAudioElement) {
    if (this.active !== el) {
      this.active.pause();
      this.active = el;
    }
    el.muted = this.mutedState;
  }

  private tryPlay(el: HTMLAudioElement, src: string): Promise<void> {
    el.src = src;
    el.volume = 0;
    return el.play();
  }

  async play(src: string): Promise<void> {
    // Fade out whatever is playing before switching tracks.
    if (!this.active.paused && this.active.src) await this.fade(0, 220);
    this.active.pause();
    try {
      // Primary path: CORS-enabled element feeding the analyser.
      await this.tryPlay(this.el, src);
      this.setActive(this.el);
      this.ensureAnalyser();
      this.usingAnalyser = true;
    } catch {
      try {
        // Source refused CORS — play it directly, no spectrum for this track.
        await this.tryPlay(this.fbEl, src);
        this.setActive(this.fbEl);
        this.usingAnalyser = false;
      } catch (e) {
        this.active.volume = this.baseVolume;
        this.onError("재생을 시작할 수 없습니다");
        throw e;
      }
    }
    void this.fade(this.baseVolume, 420);
  }

  toggle(): void {
    const el = this.active;
    if (!el.src) return;
    if (el.paused) {
      el.volume = 0;
      if (this.actx?.state === "suspended") void this.actx.resume();
      void el.play().then(() => this.fade(this.baseVolume, 420)).catch(() => {});
    } else {
      void this.fadeOutThen(() => el.pause());
    }
  }

  pause(): void {
    void this.fadeOutThen(() => this.active.pause());
  }

  stop(): void {
    void this.fadeOutThen(() => {
      this.active.pause();
      try {
        this.active.currentTime = 0;
      } catch {
        /* ignore */
      }
      this.onState(false);
      this.onTime(0, this.dur);
    });
  }

  seekFraction(f: number): void {
    if (this.dur > 0) this.active.currentTime = Math.max(0, Math.min(1, f)) * this.dur;
  }

  setVolume(v: number): void {
    this.baseVolume = Math.max(0, Math.min(1, v));
    this.fadeToken++; // cancel any running fade
    this.active.volume = this.baseVolume;
  }

  private mutedState = false;
  setMuted(m: boolean): void {
    this.mutedState = m;
    this.active.muted = m;
  }

  get paused(): boolean {
    return this.active.paused;
  }

  get hasSrc(): boolean {
    return !!this.active.src;
  }
}
