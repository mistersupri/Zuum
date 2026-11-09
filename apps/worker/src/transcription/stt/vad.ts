// Energy-based voice activity detection over 16-bit mono PCM.
// Cuts a continuous track into utterances so non-streaming STT (Whisper) can
// transcribe one utterance at a time, and so silence never reaches the model
// (Whisper invents text on silence, e.g. "Terima kasih telah menonton").

export interface Utterance {
  index: number;
  startSec: number;
  endSec: number;
  pcm: Int16Array;
}

export interface VadOptions {
  sampleRate: number;
  /** RMS on the int16 scale above which a 10 ms frame counts as speech. */
  threshold?: number;
  /** Silence that closes an utterance. */
  hangoverMs?: number;
  /** Utterances are cut at this length so results keep flowing during monologues. */
  maxUtteranceSec?: number;
  /** Shorter bursts (clicks, coughs) are dropped. */
  minUtteranceSec?: number;
  /** Audio kept before the speech onset so first syllables are not clipped. */
  preRollMs?: number;
}

export interface VadEvents {
  onSpeechStart?(startSec: number): void;
  /** Called periodically while speech continues, with the audio so far. */
  onProgress?(u: Omit<Utterance, "index">): void;
  onUtterance(u: Utterance): void;
}

export class Vad {
  private readonly frameLen: number;
  private readonly threshold: number;
  private readonly hangoverFrames: number;
  private readonly maxSamples: number;
  private readonly minSec: number;
  private readonly preRollFrames: number;
  private samples = 0;
  private carry = new Int16Array(0);
  private speaking = false;
  private speechStartSample = 0;
  private silentFrames = 0;
  private frames: Int16Array[] = [];
  private preRoll: Int16Array[] = [];
  private index = 0;

  constructor(
    private readonly opts: VadOptions,
    private readonly events: VadEvents,
  ) {
    this.frameLen = Math.round(opts.sampleRate * 0.01);
    this.threshold = opts.threshold ?? 500;
    this.hangoverFrames = Math.round((opts.hangoverMs ?? 600) / 10);
    this.maxSamples = Math.round((opts.maxUtteranceSec ?? 20) * opts.sampleRate);
    this.minSec = opts.minUtteranceSec ?? 0.3;
    this.preRollFrames = Math.round((opts.preRollMs ?? 200) / 10);
  }

  get currentSec() {
    return this.samples / this.opts.sampleRate;
  }

  push(pcm: Int16Array) {
    const buf = new Int16Array(this.carry.length + pcm.length);
    buf.set(this.carry);
    buf.set(pcm, this.carry.length);
    let off = 0;
    for (; off + this.frameLen <= buf.length; off += this.frameLen) {
      this.frame(buf.subarray(off, off + this.frameLen));
    }
    this.carry = buf.slice(off);
  }

  /** Closes any utterance in progress (track ended or stream closing). */
  flush() {
    if (this.speaking) this.close(this.samples);
  }

  private frame(f: Int16Array) {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i]! * f[i]!;
    const loud = Math.sqrt(sum / f.length) > this.threshold;
    const copy = f.slice();
    const frameStart = this.samples;
    this.samples += f.length;

    if (!this.speaking) {
      this.preRoll.push(copy);
      if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
      if (!loud) return;
      this.speaking = true;
      this.silentFrames = 0;
      this.frames = [...this.preRoll];
      this.preRoll = [];
      this.speechStartSample = Math.max(0, frameStart - (this.frames.length - 1) * this.frameLen);
      this.events.onSpeechStart?.(this.speechStartSample / this.opts.sampleRate);
      return;
    }

    this.frames.push(copy);
    this.silentFrames = loud ? 0 : this.silentFrames + 1;
    const length = this.samples - this.speechStartSample;
    if (this.silentFrames >= this.hangoverFrames) {
      // End the utterance where the silence began, not where it was detected.
      const trim = this.silentFrames;
      this.frames.splice(this.frames.length - trim, trim);
      this.close(this.samples - trim * this.frameLen);
    } else if (length >= this.maxSamples) {
      this.close(this.samples);
    } else if (this.events.onProgress && this.frames.length % 100 === 0) {
      this.events.onProgress({ startSec: this.speechStartSample / this.opts.sampleRate, endSec: this.currentSec, pcm: concat(this.frames) });
    }
  }

  private close(endSample: number) {
    const startSec = this.speechStartSample / this.opts.sampleRate;
    const endSec = endSample / this.opts.sampleRate;
    const pcm = concat(this.frames);
    this.speaking = false;
    this.silentFrames = 0;
    this.frames = [];
    if (endSec - startSec < this.minSec) return;
    this.events.onUtterance({ index: this.index++, startSec, endSec, pcm });
  }
}

export function concat(parts: Int16Array[]) {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 16-bit PCM mono WAV, the format every Whisper server accepts. */
export function encodeWav(pcm: Int16Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataLen = pcm.length * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, dataLen)]);
}
