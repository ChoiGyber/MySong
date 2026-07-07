// Canvas waveform visualizer.
//
// It runs in "simulated" mode: bars animate while audio is playing and settle to
// a low idle line when paused. This keeps the visualizer working uniformly for
// both local files and remote (YouTube) streams — a real Web Audio AnalyserNode
// can't tap cross-origin streams without muting them, so we don't route through it.

const BAR_COUNT = 44;

export class Visualizer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private heights: number[] = new Array(BAR_COUNT).fill(0.04);
  private targets: number[] = new Array(BAR_COUNT).fill(0.04);
  private playing = false;
  private volume = 0.8;
  private t = 0;
  private raf = 0;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.resize();
    this.loop();
  }

  setPlaying(p: boolean) {
    this.playing = p;
  }

  setVolume(v: number) {
    this.volume = v;
  }

  private resize() {
    this.dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.max(1, Math.floor(w * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(h * this.dpr));
  }

  private nextTargets() {
    // Spectrum-shaped pseudo-analyser: bass on the left (tall, slow swells,
    // pulsing on a common beat), treble on the right (short, fast flicker).
    const beat = 0.55 + 0.45 * Math.max(0, Math.sin(this.t * 2.2)) ** 2;
    for (let i = 0; i < BAR_COUNT; i++) {
      if (!this.playing) {
        this.targets[i] = 0.05;
        continue;
      }
      const x = i / (BAR_COUNT - 1); // 0 = bass … 1 = treble
      const envelope = 1 - 0.58 * x; // low end carries more energy
      const speed = 1.6 + 5.2 * x; // highs oscillate faster
      const a = Math.sin(this.t * speed + i * 0.7);
      const b = Math.sin(this.t * speed * 1.9 + i * 0.31 + 1.3);
      let v = 0.5 + 0.5 * (a * 0.55 + b * 0.45);
      v = v * v; // punchier peaks
      const bassPulse = 0.7 + 0.3 * beat * (1 - x); // beat hits the left hardest
      this.targets[i] = Math.max(
        0.06,
        v * envelope * bassPulse * (0.45 + 0.55 * this.volume)
      );
    }
  }

  private loop = () => {
    this.t += 0.045;
    this.nextTargets();

    const { ctx, canvas, dpr } = this;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const gap = 2 * dpr;
    const bw = (W - gap * (BAR_COUNT - 1)) / BAR_COUNT;
    const baseline = H - 2 * dpr;

    for (let i = 0; i < BAR_COUNT; i++) {
      // Ease current height toward target.
      this.heights[i] += (this.targets[i] - this.heights[i]) * 0.22;
      const bh = Math.max(2 * dpr, this.heights[i] * (H - 4 * dpr));
      const x = i * (bw + gap);
      const y = baseline - bh;

      const grad = ctx.createLinearGradient(0, y, 0, baseline);
      grad.addColorStop(0, "#ffe27a");
      grad.addColorStop(1, "#ffcf33");
      ctx.fillStyle = grad;
      this.roundRect(ctx, x, y, bw, bh, Math.min(bw / 2, 2.5 * dpr));
      ctx.fill();
    }

    this.raf = requestAnimationFrame(this.loop);
  };

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
  }
}
