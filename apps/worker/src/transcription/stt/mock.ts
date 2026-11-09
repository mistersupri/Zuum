import type { SttCallbacks, SttProvider, SttStream } from "./types";

/**
 * Local test provider. It does not recognize speech: it runs a simple energy VAD
 * and emits a clearly labeled placeholder per detected utterance, so the full
 * track -> worker -> DB -> SSE -> UI path can be exercised without an STT key.
 * Never enable in production (STT_PROVIDER=mock).
 */
export class MockSttProvider implements SttProvider {
  readonly name = "mock";

  async open(opts: { language: string; sampleRate: number }, cb: SttCallbacks): Promise<SttStream> {
    const frameSec = 0.01;
    const threshold = 500; // RMS on int16 scale
    const hangoverFrames = 40; // 400 ms of silence closes an utterance
    let samples = 0;
    let speaking = false;
    let speechStart = 0;
    let silent = 0;
    let index = 0;
    let lastPartialAt = 0;
    const frameLen = Math.round(opts.sampleRate * frameSec);
    let carry = new Int16Array(0);

    const emitFinal = (endSec: number) => {
      const dur = endSec - speechStart;
      if (dur >= 0.25) {
        cb.onResult({
          index: index++,
          isFinal: true,
          text: `[uji STT] ucapan terdeteksi selama ${dur.toFixed(1).replace(".", ",")} detik`,
          startSec: speechStart,
          endSec,
          confidence: 1,
        });
      }
      speaking = false;
      silent = 0;
    };

    return {
      write(pcm) {
        const buf = new Int16Array(carry.length + pcm.length);
        buf.set(carry);
        buf.set(pcm, carry.length);
        let off = 0;
        for (; off + frameLen <= buf.length; off += frameLen) {
          let sum = 0;
          for (let i = off; i < off + frameLen; i++) sum += buf[i]! * buf[i]!;
          const rms = Math.sqrt(sum / frameLen);
          const t = samples / opts.sampleRate;
          samples += frameLen;
          if (rms > threshold) {
            if (!speaking) {
              speaking = true;
              speechStart = t;
            }
            silent = 0;
            if (t - lastPartialAt > 0.7) {
              lastPartialAt = t;
              cb.onResult({ index, isFinal: false, text: "[uji STT] sedang mendengarkan", startSec: speechStart, endSec: t, confidence: null });
            }
          } else if (speaking && ++silent >= hangoverFrames) {
            emitFinal(t - hangoverFrames * frameSec);
          }
          if (speaking && t - speechStart > 15) emitFinal(t);
        }
        carry = buf.slice(off);
      },
      async close() {
        if (speaking) emitFinal(samples / opts.sampleRate);
      },
    };
  }
}
