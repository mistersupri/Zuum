import type { SttCallbacks, SttProvider, SttStream } from "./types";
import { encodeWav, Vad, type Utterance } from "./vad";

export interface WhisperOptions {
  /** OpenAI-compatible base URL, e.g. http://whisper:8000/v1 (speaches / faster-whisper) or https://api.groq.com/openai/v1. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Re-transcribe the utterance in progress this often to show partial text. 0 disables partials. */
  partialIntervalMs: number;
  /** Segments Whisper itself thinks are probably not speech are dropped above this. */
  noSpeechThreshold: number;
  timeoutMs: number;
}

interface VerboseJson {
  text: string;
  segments?: { avg_logprob?: number; no_speech_prob?: number; text: string }[];
}

// Phrases Whisper is known to produce on Indonesian non-speech audio (subtitle credits in its
// training data). Dropped only when they make up the whole utterance.
const HALLUCINATIONS = [
  /^terima kasih (telah|sudah) menonton\.?$/i,
  /^(sampai jumpa|terima kasih)\.?$/i,
  /^subtitle (oleh|by) .*$/i,
  /^thanks for watching\.?$/i,
];

/**
 * Speech-to-text through any OpenAI-compatible /audio/transcriptions endpoint.
 * Free when self-hosted (faster-whisper via speaches, whisper.cpp); low cost on hosted
 * Whisper APIs. Whisper is not a streaming model, so audio is cut into utterances with
 * a VAD and each utterance is sent once it ends (PRD 4.8 step 4: "potongan audio pendek berurutan").
 */
export class WhisperProvider implements SttProvider {
  readonly name = "whisper";
  constructor(private readonly opts: WhisperOptions) {}

  async transcribe(pcm: Int16Array, sampleRate: number, language: string, signal?: AbortSignal) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(encodeWav(pcm, sampleRate))], { type: "audio/wav" }), "utterance.wav");
    form.append("model", this.opts.model);
    form.append("language", language);
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      body: form,
      headers: this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {},
      signal: signal ?? AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) throw new Error(`Whisper HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as VerboseJson;
    const segments = (body.segments ?? []).filter((s) => (s.no_speech_prob ?? 0) < this.opts.noSpeechThreshold);
    const text = (body.segments ? segments.map((s) => s.text).join(" ") : body.text).replace(/\s+/g, " ").trim();
    if (!text || HALLUCINATIONS.some((re) => re.test(text))) return { text: "", confidence: null };
    const logprobs = segments.map((s) => s.avg_logprob).filter((v): v is number => typeof v === "number");
    // exp(mean log-probability) as a rough 0..1 confidence; null when the server does not report it.
    const confidence = logprobs.length ? Math.exp(logprobs.reduce((a, b) => a + b, 0) / logprobs.length) : null;
    return { text, confidence };
  }

  async open(opts: { language: string; sampleRate: number }, cb: SttCallbacks): Promise<SttStream> {
    // Results are delivered strictly in utterance order, even if requests finish out of order.
    let chain = Promise.resolve();
    let partialBusy = false;
    let lastPartialAt = 0;
    let latestIndex = 0;

    const finalize = (u: Utterance) => {
      latestIndex = u.index + 1;
      const job = this.transcribe(u.pcm, opts.sampleRate, opts.language);
      chain = chain.then(async () => {
        try {
          const r = await job;
          cb.onResult({ index: u.index, isFinal: true, text: r.text, startSec: u.startSec, endSec: u.endSec, confidence: r.confidence });
        } catch (err) {
          cb.onError(err as Error);
        }
      });
    };

    const vad = new Vad(
      { sampleRate: opts.sampleRate, hangoverMs: 600, maxUtteranceSec: 20 },
      {
        onUtterance: finalize,
        onProgress:
          this.opts.partialIntervalMs > 0
            ? (u) => {
                const now = Date.now();
                if (partialBusy || now - lastPartialAt < this.opts.partialIntervalMs) return;
                partialBusy = true;
                lastPartialAt = now;
                const index = latestIndex;
                this.transcribe(u.pcm, opts.sampleRate, opts.language)
                  .then((r) => {
                    // Skip if the utterance already closed while this partial was in flight.
                    if (r.text && index === latestIndex) cb.onResult({ index, isFinal: false, text: r.text, startSec: u.startSec, endSec: u.endSec, confidence: null });
                  })
                  .catch(() => undefined)
                  .finally(() => {
                    partialBusy = false;
                  });
              }
            : undefined,
      },
    );

    return {
      write: (pcm) => vad.push(pcm),
      close: async () => {
        vad.flush();
        await chain;
      },
    };
  }
}
