import type { Role } from "@zuum/shared";

export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  locale: string;
  timezone: string;
  emailVerified: boolean;
}

export type MeetingStatus = "SCHEDULED" | "LIVE" | "ENDED" | "CANCELLED";

export interface Meeting {
  id: string;
  code: string;
  title: string;
  description: string | null;
  agenda: string[];
  status: MeetingStatus;
  ownerId: string;
  scheduledAt: string | null;
  durationMinutes: number | null;
  startedAt: string | null;
  endedAt: string | null;
  timezone: string;
  language: string;
  maxParticipants: number;
  guestLinkEnabled: boolean;
  waitingRoom: boolean;
  locked: boolean;
  hasPasscode: boolean;
  recordingEnabled: boolean;
  recordingActive: boolean;
  transcriptionEnabled: boolean;
  transcriptVisibility: "HOST_ONLY" | "HOST_AND_PARTICIPANTS" | "EVERYONE";
  participantsCanDownload: boolean;
  coHostCanMute: boolean;
  coHostCanRemove: boolean;
  coHostCanRecord: boolean;
  chatAsAiContext: boolean;
  retentionDays: number;
  createdAt: string;
  // list extras
  isOwner?: boolean;
  ownerName?: string;
  transcriptStatus?: string | null;
  aiStatus?: string | null;
  aiErrorCode?: string | null;
  attendeeCount?: number;
  matchedTranscript?: boolean;
}

export interface Permissions {
  manage: boolean;
  end: boolean;
  mute: boolean;
  remove: boolean;
  admit: boolean;
  lock: boolean;
  record: boolean;
  viewTranscript: boolean;
  editTranscript: boolean;
  viewResults: boolean;
  download: boolean;
  generateAi: boolean;
  review: boolean;
}

export interface ParticipantRow {
  id: string;
  displayName: string;
  role: Role;
  status: "INVITED" | "WAITING" | "JOINED" | "LEFT" | "REMOVED" | "REJECTED";
  isGuest: boolean;
  identity: string;
  joinedAt: string | null;
  leftAt?: string | null;
  admittedAt?: string | null;
}

export interface MeetingDetail {
  meeting: Meeting;
  me: {
    participantId: string | null;
    role: Role;
    status: string | null;
    admitted: boolean;
    permissions: Permissions;
  };
  participants: ParticipantRow[];
}

export interface JoinResponse {
  status: "JOINED" | "WAITING" | "NOT_STARTED";
  meetingId: string;
  participantId: string;
  role?: Role;
  guestToken: string | null;
  livekit?: { url: string; token: string };
  permissions?: { canPublish: boolean; canSubscribe: boolean; canShareScreen: boolean; canRecord: boolean; canViewTranscript: boolean };
}

export interface ChatMessage {
  id: string;
  body: string;
  createdAt: string;
  participantId: string;
  senderName: string;
}

export interface AiJob {
  id: string;
  type: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  model: string | null;
  promptVersion: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface Topic {
  id: string;
  title: string;
  summary: string;
  startMs: number | null;
  endMs: number | null;
  evidenceSegmentIds: string[];
  contributorIds: string[];
}

export interface Decision {
  id: string;
  description: string;
  context: string | null;
  status: "PROPOSED" | "CONFIRMED" | "REJECTED" | "NEEDS_REVIEW";
  evidenceSegmentIds: string[];
  confidence: number | null;
}

export interface ActionItem {
  id: string;
  description: string;
  assigneeParticipantId: string | null;
  assignee: { id: string; displayName: string } | null;
  dueDate: string | null;
  status: "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED";
  evidenceSegmentIds: string[];
  confidence: number | null;
  needsReview: boolean;
}

export interface Summary {
  overview: string;
  purpose: string | null;
  keyPoints: string[];
  needsReview: boolean;
  version: number;
  generatedAt: string;
  model: string | null;
  promptVersion: string | null;
}

export interface MinutesContent {
  title: string;
  dateLine: string;
  host: string;
  participants: string[];
  agenda: string[];
  summary: string;
  sections: { topic: string; discussion: string }[];
  closingNotes: string | null;
  disclaimer: string;
}

export interface Asset {
  id: string;
  type: string;
  status: "QUEUED" | "RECORDING" | "PROCESSING" | "READY" | "FAILED" | "DELETED";
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  createdAt: string;
  readyAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}
