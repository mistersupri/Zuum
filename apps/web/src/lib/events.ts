import { useEffect, useRef } from "react";
import type { RealtimeEvent } from "@zuum/shared";
import { apiBase, guestSession, refreshAccessToken, session } from "./api";

type Handler = (ev: RealtimeEvent<any>) => void;

/**
 * Subscribes to the meeting SSE stream with fetch() so the bearer token travels in a header.
 * Reconnects with backoff, and drops duplicate events by eventId (PRD 10).
 */
export function useMeetingEvents(meetingId: string | undefined, onEvent: Handler, enabled = true) {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!meetingId || !enabled) return;
    let stopped = false;
    let ctrl: AbortController | null = null;
    const seen = new Set<string>();
    const seenOrder: string[] = [];

    const run = async (attempt: number): Promise<void> => {
      if (stopped) return;
      ctrl = new AbortController();
      try {
        const token = session.get() ?? guestSession.get(meetingId);
        const res = await fetch(`${apiBase}/meetings/${meetingId}/events`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
          signal: ctrl.signal,
        });
        if (res.status === 401 && session.get()) {
          await refreshAccessToken();
          return run(attempt + 1);
        }
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        attempt = 0;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = block
              .split("\n")
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("\n");
            if (!data || data === "{}") continue;
            try {
              const ev = JSON.parse(data) as RealtimeEvent;
              if (seen.has(ev.eventId)) continue;
              seen.add(ev.eventId);
              seenOrder.push(ev.eventId);
              if (seenOrder.length > 2000) seen.delete(seenOrder.shift()!);
              handler.current(ev);
            } catch {
              /* malformed event */
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
      }
      if (stopped) return;
      const delay = Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4));
      setTimeout(() => void run(attempt + 1), delay);
    };
    void run(0);
    return () => {
      stopped = true;
      ctrl?.abort();
    };
  }, [meetingId, enabled]);
}
