import type { SttCallbacks, SttProvider, SttStream } from "./types";
import { Vad } from "./vad";

/**
 * Local test provider. It does not recognize speech: it runs the same VAD as the
 * Whisper adapter and emits a clearly labeled placeholder per detected utterance, so the
 * full track -> worker -> DB -> SSE -> UI path can be exercised without any STT service.
 * Never enable in production (STT_PROVIDER=mock).
 */
export class MockSttProvider implements SttProvider {
  readonly name = "mock";

  async open(opts: { language: string; sampleRate: number }, cb: SttCallbacks): Promise<SttStream> {
    let index = 0;
    let lastPartial = 0;
    const vad = new Vad(
      { sampleRate: opts.sampleRate, hangoverMs: 400, maxUtteranceSec: 15, minUtteranceSec: 0.25 },
      {
        onProgress: (u) => {
          if (u.endSec - lastPartial < 0.7) return;
          lastPartial = u.endSec;
          cb.onResult({ index, isFinal: false, text: "[uji STT] sedang mendengarkan", startSec: u.startSec, endSec: u.endSec, confidence: null });
        },
        onUtterance: (u) => {
          index = u.index + 1;
          const dur = (u.endSec - u.startSec).toFixed(1).replace(".", ",");
          cb.onResult({
            index: u.index,
            isFinal: true,
            text: `[uji STT] ucapan terdeteksi selama ${dur} detik`,
            startSec: u.startSec,
            endSec: u.endSec,
            confidence: 1,
          });
        },
      },
    );
    return {
      write: (pcm) => vad.push(pcm),
      close: async () => vad.flush(),
    };
  }
}
