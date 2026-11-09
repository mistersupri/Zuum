// Permission matrix from PRD 3.2. The backend is the only enforcer; the web
// client uses the same function to hide controls the user cannot use.

export type Role = "OWNER" | "HOST" | "CO_HOST" | "PARTICIPANT" | "GUEST";

export type Action =
  | "meeting.join"
  | "meeting.manage"
  | "meeting.end"
  | "media.muteSelf"
  | "participant.mute"
  | "participant.remove"
  | "participant.admit"
  | "room.lock"
  | "recording.control"
  | "transcript.viewLive"
  | "transcript.edit"
  | "results.download"
  | "results.view"
  | "ai.generate"
  | "results.review";

export interface MeetingPolicy {
  transcriptVisibility: "HOST_ONLY" | "HOST_AND_PARTICIPANTS" | "EVERYONE";
  participantsCanDownload: boolean;
  coHostCanMute: boolean;
  coHostCanRemove: boolean;
  coHostCanRecord: boolean;
}

export const isHostRole = (role: Role) => role === "OWNER" || role === "HOST";
export const isModerator = (role: Role) => isHostRole(role) || role === "CO_HOST";

export function can(role: Role, action: Action, policy: MeetingPolicy): boolean {
  switch (action) {
    case "meeting.join":
    case "media.muteSelf":
      return true;
    case "meeting.manage":
    case "meeting.end":
    case "ai.generate":
    case "results.review":
      return isHostRole(role);
    case "participant.admit":
      return isModerator(role);
    case "room.lock":
      return isModerator(role);
    case "participant.mute":
      return isHostRole(role) || (role === "CO_HOST" && policy.coHostCanMute);
    case "participant.remove":
      return isHostRole(role) || (role === "CO_HOST" && policy.coHostCanRemove);
    case "recording.control":
      return isHostRole(role) || (role === "CO_HOST" && policy.coHostCanRecord);
    case "transcript.edit":
      return isModerator(role);
    case "transcript.viewLive":
      if (isModerator(role)) return true;
      if (policy.transcriptVisibility === "HOST_ONLY") return false;
      if (role === "GUEST") return policy.transcriptVisibility === "EVERYONE";
      return true;
    case "results.view":
      if (isModerator(role)) return true;
      if (role === "GUEST") return false;
      return policy.transcriptVisibility !== "HOST_ONLY";
    case "results.download":
      if (isHostRole(role)) return true;
      if (role === "GUEST") return false;
      return policy.participantsCanDownload;
  }
}

export const ROLE_LABEL: Record<Role, string> = {
  OWNER: "Pemilik",
  HOST: "Host",
  CO_HOST: "Co-host",
  PARTICIPANT: "Peserta",
  GUEST: "Tamu",
};
