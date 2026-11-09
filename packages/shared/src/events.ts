// Realtime event contract (PRD section 10).
// Every event carries eventId, meetingId, occurredAt, version and payload.
// Clients must tolerate duplicates and out-of-order delivery: they dedupe on
// eventId and use `version` (monotonic per resource) to drop stale updates.

export const REALTIME_EVENT_TYPES = [
  "meeting.participant.joined",
  "meeting.participant.left",
  "meeting.participant.waiting",
  "meeting.participant.admitted",
  "meeting.participant.rejected",
  "meeting.participant.removed",
  "meeting.participant.updated",
  "meeting.recording.started",
  "meeting.recording.stopped",
  "meeting.recording.updated",
  "meeting.locked",
  "meeting.unlocked",
  "meeting.chat.message",
  "transcript.segment.partial",
  "transcript.segment.final",
  "transcript.segment.corrected",
  "transcript.status.updated",
  "ai.job.started",
  "ai.job.completed",
  "ai.job.failed",
  "meeting.ended",
] as const;

export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

export type EventAudience =
  // every admitted participant
  | "participants"
  // owner, host and co-hosts only
  | "hosts"
  // participants allowed to see the live transcript (resolved per meeting setting)
  | "transcript"
  // one participant (e.g. a waiting guest learning they were admitted)
  | { participantId: string };

export interface RealtimeEvent<P = unknown> {
  eventId: string;
  type: RealtimeEventType;
  meetingId: string;
  occurredAt: string;
  version: number;
  audience: EventAudience;
  payload: P;
}

export interface TranscriptSegmentDTO {
  id: string;
  sequence: number;
  participantId: string | null;
  trackSid: string | null;
  speakerName: string;
  speakerVerified: boolean;
  startMs: number;
  endMs: number;
  timingEstimated: boolean;
  text: string;
  originalText: string;
  correctedText: string | null;
  status: "PARTIAL" | "FINAL" | "NEEDS_REVIEW" | "CORRECTED";
  confidence: number | null;
  language: string;
}

export interface PartialSegmentPayload {
  // Stable key for the utterance in progress, replaced when the final arrives.
  utteranceKey: string;
  participantId: string | null;
  speakerName: string;
  startMs: number;
  text: string;
}

export interface FinalSegmentPayload {
  utteranceKey: string;
  segment: TranscriptSegmentDTO;
}

export const redisChannelForMeeting = (meetingId: string) => `zuum:meeting:${meetingId}`;
