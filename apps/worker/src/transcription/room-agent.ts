import { AudioStream, Room, RoomEvent, TrackKind, type AudioFrame, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";
import { randomBytes } from "node:crypto";
import { prisma } from "@zuum/db";
import { config } from "../config";
import { Lease, log, publish, roomLeaseKey, trackLeaseKey } from "../shared";
import { emitPartial, persistFinal, type StreamContext } from "./sink";
import { DeepgramProvider } from "./stt/deepgram";
import { MockSttProvider } from "./stt/mock";
import type { SttProvider, SttStream } from "./stt/types";

const SAMPLE_RATE = 16_000;
export const AGENT_IDENTITY_PREFIX = "zuum-transcriber";

function provider(): SttProvider {
  if (config.STT_PROVIDER === "mock") return new MockSttProvider();
  if (!config.DEEPGRAM_API_KEY) throw new Error("DEEPGRAM_API_KEY belum diisi; transkripsi tidak dapat berjalan.");
  return new DeepgramProvider(config.DEEPGRAM_API_KEY, config.DEEPGRAM_MODEL);
}

interface TrackTranscriber {
  lease: Lease;
  stream: SttStream | null;
  reader: ReadableStreamDefaultReader<AudioFrame>;
  done: Promise<void>;
}

/**
 * Joins a LiveKit room as a hidden, subscribe-only participant and runs one STT
 * stream per participant audio track (PRD 4.8 "Desain audio per peserta").
 * Audio never passes through the Node.js API (PRD 5.3).
 */
export class RoomAgent {
  private room = new Room();
  private tracks = new Map<string, TrackTranscriber>();
  private errors = 0;
  private stopped = false;
  readonly finished: Promise<void>;
  private resolveFinished!: () => void;

  constructor(
    private readonly meetingId: string,
    private readonly roomName: string,
    private readonly lease: Lease,
    private readonly stt: SttProvider,
  ) {
    this.finished = new Promise((r) => (this.resolveFinished = r));
  }

  static async start(meetingId: string, roomName: string): Promise<RoomAgent | null> {
    const lease = new Lease(roomLeaseKey(roomName));
    if (!(await lease.acquire())) return null; // another worker already transcribes this room
    try {
      const agent = new RoomAgent(meetingId, roomName, lease, provider());
      await agent.connect();
      return agent;
    } catch (err) {
      await lease.release();
      throw err;
    }
  }

  private async connect() {
    const at = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
      identity: `${AGENT_IDENTITY_PREFIX}-${randomBytes(4).toString("hex")}`,
      name: "Zuum Transkripsi",
      ttl: 3600,
    });
    at.addGrant({ room: this.roomName, roomJoin: true, canPublish: false, canSubscribe: true, canPublishData: false, hidden: true });

    this.room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      this.onTrack(track, pub, participant).catch((err) => {
        this.errors++;
        log.error({ err, meetingId: this.meetingId, trackSid: pub.sid }, "transkripsi track gagal dimulai");
      });
    });
    this.room.on(RoomEvent.TrackUnsubscribed, (_track, pub) => {
      if (pub.sid) void this.closeTrack(pub.sid);
    });
    this.room.on(RoomEvent.Disconnected, () => {
      void this.stop("disconnected");
    });

    await this.room.connect(config.LIVEKIT_URL, await at.toJwt(), { autoSubscribe: true, dynacast: false });
    await prisma.transcript.updateMany({
      where: { meetingId: this.meetingId, status: { in: ["PENDING", "PARTIAL"] } },
      data: { status: "STREAMING" },
    });
    await publish(this.meetingId, "transcript.status.updated", "transcript", { status: "STREAMING" });
    log.info({ meetingId: this.meetingId }, "agen transkripsi bergabung ke room");

    // Tracks published before the agent joined arrive through TrackSubscribed as well.
  }

  private async onTrack(track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) {
    if (track.kind !== TrackKind.KIND_AUDIO || !pub.sid) return;
    if (participant.identity.startsWith("zuum-") || participant.identity.startsWith("EG_")) return;
    if (this.tracks.has(pub.sid)) return;

    // One active transcription per track, across all workers (PRD 6.1 step 6).
    const lease = new Lease(trackLeaseKey(pub.sid));
    if (!(await lease.acquire())) return;

    const [meeting, mp] = await Promise.all([
      prisma.meeting.findUniqueOrThrow({ where: { id: this.meetingId }, include: { transcript: true } }),
      prisma.meetingParticipant.findUnique({
        where: { meetingId_identity: { meetingId: this.meetingId, identity: participant.identity } },
      }),
    ]);
    if (!meeting.transcript || !meeting.transcriptionEnabled) {
      await lease.release();
      return;
    }
    if (mp) {
      await prisma.participantTrack.upsert({
        where: { participantId_trackSid: { participantId: mp.id, trackSid: pub.sid } },
        create: { participantId: mp.id, trackSid: pub.sid, trackType: "audio", transcriptionKey: config.WORKER_ID },
        update: { transcriptionKey: config.WORKER_ID, endedAt: null },
      });
    }

    const ctx: StreamContext = {
      meetingId: this.meetingId,
      transcriptId: meeting.transcript.id,
      participantId: mp?.id ?? null,
      // Identity comes from the authenticated track publisher, never from voice (PRD 4.8).
      speakerName: mp?.displayName ?? participant.name ?? "Pembicara tidak dikenal",
      speakerVerified: !!mp,
      trackSid: pub.sid,
      streamStartedAt: Date.now(),
      meetingStartedAt: (meeting.startedAt ?? meeting.createdAt).getTime(),
      epoch: `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`,
      provider: this.stt.name,
      language: meeting.language,
    };

    const audio = new AudioStream(track, SAMPLE_RATE, 1);
    const reader = audio.getReader();
    const entry: TrackTranscriber = { lease, stream: null, reader, done: Promise.resolve() };
    this.tracks.set(pub.sid, entry);

    let pending = Promise.resolve();
    entry.stream = await this.stt.open(
      { language: config.STT_LANGUAGE, sampleRate: SAMPLE_RATE },
      {
        onResult: (r) => {
          // Serialize writes per track so sequence order follows speech order.
          pending = pending
            .then(() => (r.isFinal ? persistFinal(ctx, r).then(() => undefined) : emitPartial(ctx, r)))
            .catch((err) => {
              this.errors++;
              log.error({ err, trackSid: ctx.trackSid }, "hasil STT gagal diproses");
            });
        },
        onError: (err) => {
          this.errors++;
          log.error({ err, trackSid: ctx.trackSid }, "stream STT error");
        },
      },
    );
    log.info({ meetingId: this.meetingId, participantId: ctx.participantId, trackSid: pub.sid }, "transkripsi track dimulai");

    entry.done = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || !value) break;
          entry.stream?.write(value.data);
        }
      } catch (err) {
        log.warn({ err, trackSid: ctx.trackSid }, "audio stream berhenti");
      } finally {
        reader.releaseLock();
        await entry.stream?.close().catch(() => undefined);
        await pending;
      }
    })();
  }

  private async closeTrack(trackSid: string) {
    const entry = this.tracks.get(trackSid);
    if (!entry) return;
    this.tracks.delete(trackSid);
    // Cancel through the reader: the stream itself is locked to it, so stream.cancel() would throw.
    await entry.reader.cancel().catch(() => undefined);
    // Flush the STT buffer (PRD 6.1 step 11), bounded so a stuck provider cannot block shutdown.
    await Promise.race([entry.done, new Promise((r) => setTimeout(r, 10_000))]);
    await entry.lease.release();
    await prisma.participantTrack.updateMany({ where: { trackSid, endedAt: null }, data: { endedAt: new Date() } });
  }

  async stop(reason: string) {
    if (this.stopped) return;
    this.stopped = true;
    await Promise.all([...this.tracks.keys()].map((sid) => this.closeTrack(sid)));
    await this.room.disconnect().catch(() => undefined);
    const meeting = await prisma.meeting.findUnique({ where: { id: this.meetingId }, select: { status: true } });
    if (meeting?.status === "ENDED") {
      // Transcript stays FINALIZING until the AI pipeline finalizes; record worker errors for it.
      await prisma.transcript.updateMany({
        where: { meetingId: this.meetingId },
        data: this.errors ? { errorCode: "WORKER_ERRORS", metadata: { workerErrors: this.errors } } : {},
      });
    } else {
      // Room closed while the meeting is still live (e.g. everyone left); the reconciler rejoins later.
      await prisma.transcript.updateMany({
        where: { meetingId: this.meetingId, status: "STREAMING" },
        data: { status: "PARTIAL" },
      });
    }
    await this.lease.release();
    log.info({ meetingId: this.meetingId, reason, errors: this.errors }, "agen transkripsi selesai");
    this.resolveFinished();
  }
}
