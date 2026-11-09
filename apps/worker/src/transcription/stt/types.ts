// Provider abstraction for speech-to-text (PRD 5.2, 5.3). A provider receives
// 16 kHz mono PCM for ONE participant track and reports partial/final results.

export interface SttResult {
  // Monotonic per stream; with the stream epoch it forms the dedupe key.
  index: number;
  isFinal: boolean;
  text: string;
  // Seconds relative to the start of this stream. null when the provider gives no timing.
  startSec: number | null;
  endSec: number | null;
  confidence: number | null;
  providerSegmentId?: string;
}

export interface SttStream {
  /** 16-bit little-endian PCM, 16 kHz, mono. */
  write(pcm: Int16Array): void;
  /** Flush buffered audio and wait for the last final result. */
  close(): Promise<void>;
}

export interface SttCallbacks {
  onResult(result: SttResult): void;
  onError(err: Error): void;
}

export interface SttProvider {
  readonly name: string;
  open(opts: { language: string; sampleRate: number }, cb: SttCallbacks): Promise<SttStream>;
}
