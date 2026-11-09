import WebSocket from "ws";
import type { SttCallbacks, SttProvider, SttStream } from "./types";

interface DeepgramResult {
  type: "Results";
  start: number;
  duration: number;
  is_final: boolean;
  speech_final: boolean;
  channel: { alternatives: { transcript: string; confidence: number }[] };
}

/**
 * Deepgram streaming STT. Interim results become partials; consecutive finals are
 * accumulated until `speech_final` (end of utterance) and emitted as one segment.
 */
export class DeepgramProvider implements SttProvider {
  readonly name = "deepgram";
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  open(opts: { language: string; sampleRate: number }, cb: SttCallbacks): Promise<SttStream> {
    const params = new URLSearchParams({
      model: this.model,
      language: opts.language,
      encoding: "linear16",
      sample_rate: String(opts.sampleRate),
      channels: "1",
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
      endpointing: "400",
      utterance_end_ms: "1200",
      vad_events: "true",
    });
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    let index = 0;
    let pending: { text: string[]; start: number; end: number; conf: number[] } | null = null;
    let closing: (() => void) | null = null;

    const flushUtterance = () => {
      if (!pending || !pending.text.join(" ").trim()) {
        pending = null;
        return;
      }
      const confs = pending.conf;
      cb.onResult({
        index: index++,
        isFinal: true,
        text: pending.text.join(" ").trim(),
        startSec: pending.start,
        endSec: pending.end,
        confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
      });
      pending = null;
    };

    ws.on("message", (raw) => {
      let msg: DeepgramResult | { type: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "UtteranceEnd") return flushUtterance();
      if (msg.type !== "Results") return;
      const r = msg as DeepgramResult;
      const alt = r.channel.alternatives[0];
      if (!alt) return;
      if (!r.is_final) {
        const sofar = [...(pending?.text ?? []), alt.transcript].join(" ").trim();
        if (sofar) {
          cb.onResult({
            index,
            isFinal: false,
            text: sofar,
            startSec: pending?.start ?? r.start,
            endSec: r.start + r.duration,
            confidence: null,
          });
        }
        return;
      }
      if (alt.transcript.trim()) {
        if (!pending) pending = { text: [], start: r.start, end: r.start + r.duration, conf: [] };
        pending.text.push(alt.transcript.trim());
        pending.end = r.start + r.duration;
        pending.conf.push(alt.confidence);
      }
      if (r.speech_final) flushUtterance();
    });
    ws.on("error", (err) => cb.onError(err));
    ws.on("close", () => {
      flushUtterance();
      closing?.();
    });

    return new Promise((resolve, reject) => {
      ws.once("open", () => {
        // Deepgram closes idle sockets; KeepAlive covers muted microphones.
        const keepAlive = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
        }, 8000);
        resolve({
          write(pcm) {
            if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
          },
          close() {
            clearInterval(keepAlive);
            if (ws.readyState !== WebSocket.OPEN) return Promise.resolve();
            return new Promise<void>((done) => {
              closing = done;
              ws.send(JSON.stringify({ type: "CloseStream" }));
              setTimeout(() => {
                ws.terminate();
                done();
              }, 5000);
            });
          },
        });
      });
      ws.once("unexpected-response", (_req, res) => reject(new Error(`Deepgram menolak koneksi: HTTP ${res.statusCode}`)));
      ws.once("error", reject);
    });
  }
}
