import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../src/config", () => ({
  config: { OLLAMA_MODEL: "qwen2.5:7b-instruct", OLLAMA_BASE_URL: "http://127.0.0.1:0", OLLAMA_TIMEOUT_MS: 5000, LLM_PROVIDER: "ollama" },
}));

const { Vad, encodeWav } = await import("../src/transcription/stt/vad");
const { WhisperProvider } = await import("../src/transcription/stt/whisper");
const { OllamaProvider } = await import("../src/ai/llm");

const RATE = 16_000;
/** `pattern` = list of [seconds, loud]. Loud = 440 Hz tone at amplitude 6000. */
function pcm(pattern: [number, boolean][]) {
  const parts: number[] = [];
  for (const [sec, loud] of pattern) {
    for (let i = 0; i < Math.round(sec * RATE); i++) parts.push(loud ? Math.round(6000 * Math.sin((2 * Math.PI * 440 * i) / RATE)) : 0);
  }
  return Int16Array.from(parts);
}

function readBody(req: IncomingMessage) {
  return new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

describe("Vad", () => {
  it("splits speech on silence and reports times relative to the stream", () => {
    const got: { start: number; end: number }[] = [];
    const vad = new Vad({ sampleRate: RATE, hangoverMs: 400 }, { onUtterance: (u) => got.push({ start: u.startSec, end: u.endSec }) });
    const audio = pcm([[1, false], [1.5, true], [1, false], [0.8, true], [1, false]]);
    // Feed in uneven chunks like a real audio stream.
    for (let o = 0; o < audio.length; o += 1234) vad.push(audio.subarray(o, o + 1234));
    vad.flush();
    expect(got).toHaveLength(2);
    expect(got[0]!.start).toBeGreaterThan(0.75);
    expect(got[0]!.start).toBeLessThanOrEqual(1);
    expect(got[0]!.end).toBeCloseTo(2.5, 1);
    expect(got[1]!.start).toBeGreaterThan(3.25);
    expect(got[1]!.end).toBeCloseTo(4.3, 1);
  });

  it("drops bursts shorter than the minimum and cuts very long speech", () => {
    const got: number[] = [];
    const vad = new Vad({ sampleRate: RATE, maxUtteranceSec: 5 }, { onUtterance: (u) => got.push(u.endSec - u.startSec) });
    vad.push(pcm([[0.1, true], [1, false], [12, true]]));
    vad.flush();
    expect(got.every((d) => d <= 5.3)).toBe(true);
    expect(got.length).toBe(3);
  });

  it("encodes a valid 16 kHz mono WAV header", () => {
    const wav = encodeWav(new Int16Array(1600), RATE);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(RATE);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.length).toBe(44 + 3200);
  });
});

describe("WhisperProvider against an OpenAI-compatible server", () => {
  let server: Server;
  let base = "";
  const requests: { auth?: string; body: string }[] = [];
  let reply: unknown = {};
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const body = (await readBody(req)).toString("latin1");
      requests.push({ auth: req.headers.authorization, body });
      expect(req.url).toBe("/v1/audio/transcriptions");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterAll(() => server.close());

  const provider = () => new WhisperProvider({ baseUrl: base, apiKey: "k", model: "Systran/faster-whisper-small", partialIntervalMs: 0, noSpeechThreshold: 0.6, timeoutMs: 5000 });

  it("sends one WAV per utterance with model and language, in order, with stream-relative timing", async () => {
    reply = { text: "Selamat pagi semua.", segments: [{ text: "Selamat pagi semua.", avg_logprob: -0.2, no_speech_prob: 0.01 }] };
    const results: { index: number; text: string; startSec: number | null; confidence: number | null }[] = [];
    const s = await provider().open({ language: "id", sampleRate: RATE }, { onResult: (r) => results.push(r), onError: (e) => { throw e; } });
    s.write(pcm([[0.5, false], [1, true], [1, false], [1, true], [0.2, false]]));
    await s.close();
    expect(results.map((r) => r.index)).toEqual([0, 1]);
    expect(results[0]!.text).toBe("Selamat pagi semua.");
    expect(results[0]!.startSec).toBeLessThan(0.5);
    expect(results[0]!.confidence).toBeCloseTo(Math.exp(-0.2), 3);
    const last = requests.at(-1)!;
    expect(last.auth).toBe("Bearer k");
    expect(last.body).toContain('name="model"\r\n\r\nSystran/faster-whisper-small');
    expect(last.body).toContain('name="language"\r\n\r\nid');
    expect(last.body).toContain("RIFF");
  });

  it("drops segments Whisper marks as non-speech and known silence hallucinations", async () => {
    const p = provider();
    reply = { text: "Terima kasih telah menonton.", segments: [{ text: "Terima kasih telah menonton.", avg_logprob: -0.3, no_speech_prob: 0.2 }] };
    expect((await p.transcribe(pcm([[1, true]]), RATE, "id")).text).toBe("");
    reply = { text: "x", segments: [{ text: "Halo", no_speech_prob: 0.9 }] };
    expect((await p.transcribe(pcm([[1, true]]), RATE, "id")).text).toBe("");
  });
});

describe("OllamaProvider", () => {
  let server: Server;
  const replies: string[] = [];
  const seen: { format: unknown; messages: { role: string; content: string }[] }[] = [];
  let provider: InstanceType<typeof OllamaProvider>;
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const body = JSON.parse((await readBody(req)).toString());
      seen.push(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: { content: replies.shift() }, prompt_eval_count: 100, eval_count: 20 }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    provider = new OllamaProvider("qwen2.5:7b-instruct", `http://127.0.0.1:${(server.address() as { port: number }).port}`, 5000);
  });
  afterAll(() => server.close());

  const schema = z.object({ overview: z.string().min(1), keyPoints: z.array(z.string()) });

  it("sends the JSON schema as the format constraint and returns validated data", async () => {
    replies.push(JSON.stringify({ overview: "Rapat membahas anggaran.", keyPoints: ["Anggaran disetujui"] }));
    const r = await provider.structured({ system: "s", user: "u", schema });
    expect(r.data.overview).toBe("Rapat membahas anggaran.");
    expect((seen.at(-1)!.format as { type: string }).type).toBe("object");
    expect(r.usage.inputTokens).toBe(100);
  });

  it("asks the model to repair invalid output once, then succeeds", async () => {
    replies.push(JSON.stringify({ overview: "" }), JSON.stringify({ overview: "Diperbaiki", keyPoints: [] }));
    const r = await provider.structured({ system: "s", user: "u", schema });
    expect(r.data.overview).toBe("Diperbaiki");
    expect(seen.at(-1)!.messages.at(-1)!.content).toContain("tidak valid");
  });

  it("fails with a schema error instead of inventing output when repair also fails", async () => {
    replies.push("bukan json", "masih bukan json");
    await expect(provider.structured({ system: "s", user: "u", schema })).rejects.toMatchObject({ code: "LLM_SCHEMA_INVALID" });
  });
});
