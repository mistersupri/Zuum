import { useCallback, useEffect, useReducer } from "react";
import type { FinalSegmentPayload, PartialSegmentPayload, RealtimeEvent, TranscriptSegmentDTO } from "@zuum/shared";
import { api } from "../lib/api";

interface State {
  loading: boolean;
  error: unknown;
  status: string | null;
  segments: TranscriptSegmentDTO[];
  partials: Record<string, PartialSegmentPayload & { at: number }>;
  // Highest event version applied per segment id; older updates are ignored (out-of-order safe).
  versions: Record<string, number>;
}

type Action =
  | { type: "loaded"; segments: TranscriptSegmentDTO[]; status: string | null }
  | { type: "error"; error: unknown }
  | { type: "event"; ev: RealtimeEvent<any> }
  | { type: "expire" };

function upsert(list: TranscriptSegmentDTO[], seg: TranscriptSegmentDTO) {
  const i = list.findIndex((s) => s.id === seg.id);
  if (i >= 0) {
    const next = list.slice();
    next[i] = seg;
    return next;
  }
  const next = [...list, seg];
  next.sort((a, b) => a.startMs - b.startMs || a.sequence - b.sequence);
  return next;
}

function reducer(state: State, a: Action): State {
  switch (a.type) {
    case "loaded":
      return { ...state, loading: false, error: null, status: a.status, segments: a.segments.reduce(upsert, state.segments) };
    case "error":
      return { ...state, loading: false, error: a.error };
    case "expire": {
      // A partial with no update for 20 s is dropped (speaker stopped, final never came).
      const now = Date.now();
      const partials = Object.fromEntries(Object.entries(state.partials).filter(([, p]) => now - p.at < 20_000));
      return Object.keys(partials).length === Object.keys(state.partials).length ? state : { ...state, partials };
    }
    case "event": {
      const ev = a.ev;
      if (ev.type === "transcript.segment.partial") {
        const p = ev.payload as PartialSegmentPayload;
        return { ...state, partials: { ...state.partials, [p.utteranceKey]: { ...p, at: Date.now() } } };
      }
      if (ev.type === "transcript.segment.final") {
        const p = ev.payload as FinalSegmentPayload;
        const { [p.utteranceKey]: _drop, ...partials } = state.partials;
        if ((state.versions[p.segment.id] ?? -1) >= ev.version) return { ...state, partials };
        return {
          ...state,
          partials,
          segments: upsert(state.segments, p.segment),
          versions: { ...state.versions, [p.segment.id]: ev.version },
        };
      }
      if (ev.type === "transcript.segment.corrected") {
        const seg = ev.payload as TranscriptSegmentDTO;
        if ((state.versions[seg.id] ?? -1) >= ev.version) return state;
        return { ...state, segments: upsert(state.segments, seg), versions: { ...state.versions, [seg.id]: ev.version } };
      }
      if (ev.type === "transcript.status.updated") {
        return { ...state, status: (ev.payload as { status: string }).status };
      }
      return state;
    }
  }
}

export function useLiveTranscript(meetingId: string | undefined, enabled: boolean) {
  const [state, dispatch] = useReducer(reducer, { loading: enabled, error: null, status: null, segments: [], partials: {}, versions: {} });

  const load = useCallback(async () => {
    if (!meetingId || !enabled) return;
    try {
      let after = 0;
      const all: TranscriptSegmentDTO[] = [];
      let status: string | null = null;
      for (;;) {
        const res = await api<{ transcript: { status: string } | null; segments: TranscriptSegmentDTO[]; nextAfterSequence: number | null }>(
          `/meetings/${meetingId}/transcript`,
          { guestFor: meetingId, query: { afterSequence: after, limit: 1000 } },
        );
        status = res.transcript?.status ?? null;
        all.push(...res.segments);
        if (res.nextAfterSequence === null) break;
        after = res.nextAfterSequence;
      }
      dispatch({ type: "loaded", segments: all, status });
    } catch (error) {
      dispatch({ type: "error", error });
    }
  }, [meetingId, enabled]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => dispatch({ type: "expire" }), 5000);
    return () => clearInterval(t);
  }, []);

  const apply = useCallback((ev: RealtimeEvent<any>) => dispatch({ type: "event", ev }), []);
  return { ...state, apply, reload: load };
}
