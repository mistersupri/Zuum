import {
  AccessToken,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient,
  S3Upload,
  TrackSource,
  WebhookReceiver,
} from "livekit-server-sdk";
import { config, livekitHttpUrl } from "../config";

export const roomService = new RoomServiceClient(livekitHttpUrl(), config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);
export const egressClient = new EgressClient(livekitHttpUrl(), config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);
export const webhookReceiver = new WebhookReceiver(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);

export interface MediaGrants {
  canPublish: boolean;
  canSubscribe: boolean;
  canShareScreen: boolean;
}

/** Short-lived token, one room, one server-generated identity, minimum grants (PRD 4.4, 11.1). */
export async function issueLivekitToken(opts: {
  roomName: string;
  identity: string;
  name: string;
  metadata: Record<string, unknown>;
  grants: MediaGrants;
}) {
  const at = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    identity: opts.identity,
    name: opts.name,
    metadata: JSON.stringify(opts.metadata),
    ttl: config.LIVEKIT_TOKEN_TTL_SECONDS,
  });
  const sources = [TrackSource.MICROPHONE, TrackSource.CAMERA];
  if (opts.grants.canShareScreen) sources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
  at.addGrant({
    room: opts.roomName,
    roomJoin: true,
    roomCreate: false,
    roomAdmin: false,
    canPublish: opts.grants.canPublish,
    canSubscribe: opts.grants.canSubscribe,
    canPublishData: true,
    canUpdateOwnMetadata: false,
    canPublishSources: sources,
  });
  return at.toJwt();
}

function s3Upload() {
  if (!config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY) return undefined;
  return new S3Upload({
    accessKey: config.S3_ACCESS_KEY_ID,
    secret: config.S3_SECRET_ACCESS_KEY,
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT ?? "",
    bucket: config.S3_BUCKET,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
  });
}

export function recordingStorageKey(meetingId: string, kind: string, ext: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `meetings/${meetingId}/${kind}-${stamp}.${ext}`;
}

/** Server-side composite recording (PRD 4.7): one browser does not carry a 100-person recording. */
export async function startCompositeRecording(roomName: string, storageKey: string) {
  const output = new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath: storageKey,
    output: s3Upload() ? { case: "s3", value: s3Upload()! } : undefined,
  });
  return egressClient.startRoomCompositeEgress(roomName, { file: output }, { layout: "grid" });
}

export async function startAudioTrackRecording(roomName: string, trackSid: string, storageKey: string) {
  const upload = s3Upload();
  return egressClient.startTrackEgress(
    roomName,
    upload ? { filepath: storageKey, output: { case: "s3", value: upload } } as never : storageKey,
    trackSid,
  );
}
