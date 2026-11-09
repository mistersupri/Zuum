import { describe, expect, it } from "vitest";
import { can, type MeetingPolicy } from "../src/permissions";

const policy: MeetingPolicy = {
  transcriptVisibility: "HOST_AND_PARTICIPANTS",
  participantsCanDownload: false,
  coHostCanMute: true,
  coHostCanRemove: false,
  coHostCanRecord: false,
};

describe("permission matrix (PRD 3.2)", () => {
  it("only owner/host end the meeting", () => {
    expect(can("OWNER", "meeting.end", policy)).toBe(true);
    expect(can("HOST", "meeting.end", policy)).toBe(true);
    expect(can("CO_HOST", "meeting.end", policy)).toBe(false);
    expect(can("PARTICIPANT", "meeting.end", policy)).toBe(false);
  });

  it("co-host powers follow the meeting configuration", () => {
    expect(can("CO_HOST", "participant.mute", policy)).toBe(true);
    expect(can("CO_HOST", "participant.remove", policy)).toBe(false);
    expect(can("CO_HOST", "recording.control", { ...policy, coHostCanRecord: true })).toBe(true);
  });

  it("guests never download by default and see the live transcript only when shared with everyone", () => {
    expect(can("GUEST", "results.download", { ...policy, participantsCanDownload: true })).toBe(false);
    expect(can("GUEST", "transcript.viewLive", policy)).toBe(false);
    expect(can("GUEST", "transcript.viewLive", { ...policy, transcriptVisibility: "EVERYONE" })).toBe(true);
  });

  it("participants cannot mute others or record", () => {
    expect(can("PARTICIPANT", "participant.mute", policy)).toBe(false);
    expect(can("PARTICIPANT", "recording.control", policy)).toBe(false);
    expect(can("PARTICIPANT", "media.muteSelf", policy)).toBe(true);
  });
});
