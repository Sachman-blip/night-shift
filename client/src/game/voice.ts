import type { Room } from "colyseus.js";
import { MSG } from "../../../shared/messages";

// Proximity falloff: full volume inside NEAR, silent beyond MAX_RANGE,
// smooth power curve between (no hard cutoff).
const NEAR = 3;
const MAX_RANGE = 18;
const FALLOFF_POW = 1.6;
const SPEAK_RMS = 0.02;

export type MicState = "pending" | "live" | "muted" | "none";

interface Peer {
  pc: RTCPeerConnection;
  gain: GainNode | null;
  analyser: AnalyserNode | null;
  el: HTMLAudioElement | null; // Chrome quirk: WebAudio only receives WebRTC
  pending: RTCIceCandidateInit[]; // audio if the stream also feeds an <audio>
  speaking: boolean;
  retries: number;
  lastGain: number;
}

/**
 * Proximity voice: WebRTC full mesh (fine for 4 players), signaled through
 * the existing Colyseus room. Fully opportunistic — the game never waits on
 * it, mic denial means listen-only, a failed pair degrades to just that
 * pair, and no WebRTC support degrades to silence.
 */
export class VoiceChat {
  micState: MicState = "pending";

  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private peers = new Map<string, Peer>();
  private ready = false; // no peer building until the mic question settles
  private speakCheckIn = 0;
  private rmsBuf = new Float32Array(512);
  private supported = typeof RTCPeerConnection !== "undefined";

  private interval: ReturnType<typeof setInterval>;

  constructor(private room: Room) {
    room.onMessage(MSG.Rtc, (m: { from?: string; data?: any }) => {
      if (m?.from && m.data) void this.onSignal(m.from, m.data);
    });
    document.addEventListener("keydown", (e) => {
      if (e.code === "KeyV") this.toggleMute();
    });
    // Self-driven, NOT the render loop: backgrounded tabs stop rAF entirely,
    // and voice must keep connecting/updating while a player is alt-tabbed.
    this.interval = setInterval(() => {
      try {
        this.update((this.room.state as any), 0.2);
      } catch {}
    }, 200);
  }

  /** Ask for the mic AFTER joining (never blocks the game join flow). */
  async init() {
    if (!this.supported || !navigator.mediaDevices?.getUserMedia) {
      this.micState = "none";
      return;
    }
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.micState = "live";
    } catch {
      this.mic = null; // denied/unavailable: still able to HEAR others
      this.micState = "none";
    }
    // only now may the mesh form — a peer built before getUserMedia
    // resolves would negotiate recv-only and never carry audio
    this.ready = true;
  }

  /** Call from a user gesture (shared with the game's audio unlock). */
  ensureCtx() {
    if (!this.supported) return;
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  toggleMute() {
    if (!this.mic) return;
    const mute = this.micState === "live";
    for (const t of this.mic.getAudioTracks()) t.enabled = !mute;
    this.micState = mute ? "muted" : "live";
  }

  isSpeaking(id: string): boolean {
    return this.peers.get(id)?.speaking ?? false;
  }

  /** Test/diagnostic snapshot. */
  debug() {
    const out: Record<
      string,
      { conn: string; gain: number; speaking: boolean; hasAudio: boolean }
    > = {};
    for (const [id, p] of this.peers) {
      out[id] = {
        conn: p.pc.connectionState,
        gain: p.lastGain,
        speaking: p.speaking,
        hasAudio: !!p.gain,
      };
    }
    return { mic: this.micState, ctx: this.ctx?.state ?? "none", peers: out };
  }

  // ---------- mesh lifecycle ----------

  private send(to: string, data: unknown) {
    this.room.send(MSG.Rtc, { to, data });
  }

  private addPeer(id: string, initiator: boolean): Peer {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    const peer: Peer = {
      pc, gain: null, analyser: null, el: null,
      pending: [], speaking: false, retries: 0, lastGain: 0,
    };
    this.peers.set(id, peer);

    if (this.mic) {
      for (const t of this.mic.getTracks()) pc.addTrack(t, this.mic);
    } else {
      pc.addTransceiver("audio", { direction: "recvonly" });
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) this.send(id, { candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.attachStream(peer, stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") this.handleFailure(id);
    };
    if (initiator) {
      pc.onnegotiationneeded = async () => {
        try {
          await pc.setLocalDescription(await pc.createOffer());
          this.send(id, { sdp: pc.localDescription });
        } catch (err) {
          console.warn("[voice] offer failed", err);
        }
      };
    }
    return peer;
  }

  private attachStream(peer: Peer, stream: MediaStream) {
    this.ensureCtx();
    if (!this.ctx) return;
    // keep a muted element alive or Chrome starves the WebAudio graph
    const el = new Audio();
    el.srcObject = stream;
    el.muted = true;
    void el.play().catch(() => {});
    peer.el = el;

    const src = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain();
    gain.gain.value = 0; // proximity update fades it in
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(gain).connect(this.ctx.destination);
    src.connect(analyser);
    peer.gain = gain;
    peer.analyser = analyser;
  }

  private removePeer(id: string) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    try {
      p.pc.close();
    } catch {}
    p.gain?.disconnect();
    p.analyser?.disconnect();
    if (p.el) {
      p.el.srcObject = null;
      p.el = null;
    }
  }

  /** A failed pair affects only that pair; retry twice, then give up. */
  private handleFailure(id: string) {
    const retries = (this.peers.get(id)?.retries ?? 0) + 1;
    this.removePeer(id);
    if (retries <= 2) {
      setTimeout(() => {
        const stillHere = (this.room.state as any).players?.get?.(id);
        if (stillHere && !this.peers.has(id)) {
          const p = this.addPeer(id, this.room.sessionId < id);
          p.retries = retries;
        }
      }, 3000);
    } else {
      console.warn(`[voice] giving up on peer ${id} (others unaffected)`);
    }
  }

  private async onSignal(from: string, data: any) {
    if (!this.supported) return;
    const peer = this.peers.get(from) ?? this.addPeer(from, false);
    const pc = peer.pc;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        for (const c of peer.pending) await pc.addIceCandidate(c);
        peer.pending = [];
        if (data.sdp.type === "offer") {
          await pc.setLocalDescription(await pc.createAnswer());
          this.send(from, { sdp: pc.localDescription });
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else peer.pending.push(data.candidate);
      }
    } catch (err) {
      console.warn("[voice] signaling error from", from, err);
    }
  }

  // ---------- per-frame ----------

  update(state: any, dt: number) {
    if (!this.supported || !this.ready) return;
    const myId = this.room.sessionId;

    // connect to newcomers (deterministic initiator: lower sessionId offers)
    state.players.forEach((_: unknown, id: string) => {
      if (id !== myId && !this.peers.has(id)) {
        this.addPeer(id, myId < id);
      }
    });
    // drop leavers without touching anyone else
    for (const id of [...this.peers.keys()]) {
      if (!state.players.get(id)) this.removePeer(id);
    }

    // proximity gain from the positions the game already syncs at 20hz
    const me = state.players.get(myId);
    if (!me || !this.ctx) return;
    for (const [id, p] of this.peers) {
      const other = state.players.get(id);
      if (!other || !p.gain) continue;
      const d = Math.hypot(other.x - me.x, other.z - me.z);
      const t = Math.min(1, Math.max(0, (d - NEAR) / (MAX_RANGE - NEAR)));
      const g = Math.pow(1 - t, FALLOFF_POW);
      p.lastGain = g;
      p.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.15);
    }

    // "who's talking" flags at 5hz
    this.speakCheckIn -= dt;
    if (this.speakCheckIn <= 0) {
      this.speakCheckIn = 0.2;
      for (const p of this.peers.values()) {
        if (!p.analyser) continue;
        p.analyser.getFloatTimeDomainData(this.rmsBuf);
        let sum = 0;
        for (let i = 0; i < this.rmsBuf.length; i++) sum += this.rmsBuf[i] ** 2;
        const rms = Math.sqrt(sum / this.rmsBuf.length);
        p.speaking = rms > SPEAK_RMS && p.lastGain > 0.03;
      }
    }
  }

  dispose() {
    clearInterval(this.interval);
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.mic?.getTracks().forEach((t) => t.stop());
  }
}
