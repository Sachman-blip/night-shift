// Synthesized sound design — no audio assets, everything is generated with
// oscillators and filtered noise. All client-side: cues are driven by synced
// state each client already has (enemy distance, own movement, round events).
//
// Layers:
//   ambient  — low detuned drone + filtered noise, slow breathing LFO
//   enemy    — growling drone whose volume tracks enemy proximity, plus a
//              heartbeat that quickens as it closes; both intensify in chase
//   steps    — noise-burst footsteps, heavier/brighter when sprinting
//   stingers — pickup / bank / death / win / loss one-shots

type StingKind =
  | "pickup" | "bank" | "death" | "win" | "loss" | "unlock"
  | "revive" | "cell" | "buy";

const ENEMY_AUDIO_RANGE = 25; // silent beyond this distance (m)

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private enemyGain!: GainNode;
  private noiseBuf!: AudioBuffer;
  private heartbeatIn = 0;

  /** Call from a user gesture (autoplay policy). Safe to call repeatedly. */
  ensureStarted() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(ctx.destination);

    this.noiseBuf = this.makeNoiseBuffer(ctx);
    this.startAmbient(ctx);
    this.startEnemyLayer(ctx);
  }

  private makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  private startAmbient(ctx: AudioContext) {
    const amb = ctx.createGain();
    amb.gain.value = 0.9;
    amb.connect(this.master);

    for (const [freq, vol] of [[55, 0.030], [57.5, 0.022]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = vol;
      osc.connect(g).connect(amb);
      osc.start();
    }

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    noise.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 160;
    const ng = ctx.createGain();
    ng.gain.value = 0.014;
    noise.connect(lp).connect(ng).connect(amb);
    noise.start();

    // slow breathing on the whole ambient bed
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.2;
    lfo.connect(lfoGain).connect(amb.gain);
    lfo.start();
  }

  private startEnemyLayer(ctx: AudioContext) {
    this.enemyGain = ctx.createGain();
    this.enemyGain.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 320;
    lp.connect(this.enemyGain).connect(this.master);

    // sub + dissonant tritone growl
    for (const [freq, type, vol] of [
      [49, "sine", 0.5],
      [98, "sawtooth", 0.35],
      [138.6, "sawtooth", 0.3],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = vol;
      osc.connect(g).connect(lp);
      osc.start();
    }
  }

  /** Per-frame: drives the enemy proximity layer. */
  update(enemyDist: number, chasing: boolean, active: boolean, dt: number) {
    const ctx = this.ctx;
    if (!ctx) return;

    const prox = Math.max(0, Math.min(1, 1 - enemyDist / ENEMY_AUDIO_RANGE));
    const intensity = active ? prox * prox * (chasing ? 1 : 0.5) : 0;
    this.enemyGain.gain.setTargetAtTime(intensity * 0.16, ctx.currentTime, 0.2);

    if (intensity > 0.02) {
      this.heartbeatIn -= dt;
      if (this.heartbeatIn <= 0) {
        this.heartbeatIn = Math.max(1.5 - prox * (chasing ? 1.15 : 0.8), 0.34);
        this.heartbeat(0.4 + intensity * 0.6);
      }
    } else {
      this.heartbeatIn = 0;
    }
  }

  private heartbeat(vol: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    for (const [offset, v] of [[0, vol], [0.17, vol * 0.6]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 52;
      const g = ctx.createGain();
      g.gain.setValueAtTime(v * 0.22, t + offset);
      g.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.13);
      osc.connect(g).connect(this.master);
      osc.start(t + offset);
      osc.stop(t + offset + 0.15);
    }
  }

  step(sprinting: boolean, crouching = false) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.9 + Math.random() * 0.25;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    // ducked steps are a muffled scuff — your own ears should agree with
    // the noise meter, otherwise crouching just feels like walking slowly
    const cutoff = crouching ? 240 : sprinting ? 700 : 420;
    lp.frequency.value = cutoff * (0.9 + Math.random() * 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(crouching ? 0.022 : sprinting ? 0.11 : 0.055, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.09);
  }

  sting(kind: StingKind) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    switch (kind) {
      case "pickup":
        this.tone(620, "sine", t, 0.06, 0.07);
        this.tone(930, "sine", t + 0.07, 0.08, 0.07);
        break;
      case "bank":
        [523, 659, 784].forEach((f, i) =>
          this.tone(f, "triangle", t + i * 0.09, 0.25, 0.09)
        );
        break;
      case "death": {
        this.tone(200, "sawtooth", t, 0.6, 0.2, 48);
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuf;
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 800;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.15, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        src.connect(lp).connect(g).connect(this.master);
        src.start(t);
        src.stop(t + 0.35);
        break;
      }
      case "win":
        [659, 784, 1046].forEach((f, i) =>
          this.tone(f, "sine", t + i * 0.16, 0.5, 0.09)
        );
        break;
      case "loss":
        this.tone(110, "sawtooth", t, 0.8, 0.12, 82.4);
        this.tone(55, "sine", t, 1.2, 0.14);
        break;
      case "unlock": // metallic clunk
        this.tone(160, "square", t, 0.1, 0.09, 120);
        this.tone(90, "sine", t + 0.06, 0.25, 0.12);
        break;
      case "revive": // pulled back to your feet
        [392, 523, 659].forEach((f, i) =>
          this.tone(f, "sine", t + i * 0.11, 0.35, 0.08)
        );
        break;
      case "cell": // fresh battery seated
        this.noiseBurst(t, 0.05, 0.05, 3200);
        this.tone(420, "square", t + 0.05, 0.05, 0.05, 620);
        break;
      case "buy":
        this.tone(700, "triangle", t, 0.08, 0.07);
        this.tone(1050, "triangle", t + 0.08, 0.14, 0.06);
        break;
    }
  }

  /** Filtered noise hit — the workhorse for impacts and splintering. */
  private noiseBurst(t: number, dur: number, vol: number, cutoff: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  /**
   * Random atmosphere one-shot, panned somewhere in the stereo field.
   * Deliberately NOT tied to the enemy — pure false alarms.
   */
  ambientOneShot() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    pan.connect(this.master);

    if (Math.random() < 0.5) {
      // distant metallic clang: bandpassed noise ping + faint sub thump
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 700 + Math.random() * 600;
      bp.Q.value = 9;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.05, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      src.connect(bp).connect(g).connect(pan);
      src.start(t);
      src.stop(t + 1);
      const thump = ctx.createOscillator();
      thump.frequency.value = 58;
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.04, t);
      tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      thump.connect(tg).connect(pan);
      thump.start(t);
      thump.stop(t + 0.45);
    } else {
      // door creak: slow warbling saw glide through a lowpass
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(95 + Math.random() * 25, t);
      osc.frequency.linearRampToValueAtTime(70, t + 0.6);
      osc.frequency.linearRampToValueAtTime(82, t + 0.9);
      osc.frequency.linearRampToValueAtTime(60, t + 1.4);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 320;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.035, t + 0.15);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
      osc.connect(lp).connect(g).connect(pan);
      osc.start(t);
      osc.stop(t + 1.6);
    }
  }

  private tone(
    freq: number,
    type: OscillatorType,
    t0: number,
    dur: number,
    vol: number,
    glideTo?: number
  ) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }
}
