// Standard error shape (PRD 9.8): { error: { code, message, requestId } }.
// Messages are user-facing Indonesian; codes are stable for the client.

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const Errors = {
  unauthorized: (msg = "Silakan masuk terlebih dahulu.") => new AppError(401, "UNAUTHORIZED", msg),
  forbidden: (msg = "Anda tidak memiliki izin untuk tindakan ini.") => new AppError(403, "FORBIDDEN", msg),
  notFound: (what = "Data") => new AppError(404, "NOT_FOUND", `${what} tidak ditemukan.`),
  validation: (details: unknown, msg = "Data yang dikirim belum lengkap atau tidak valid.") =>
    new AppError(400, "VALIDATION_ERROR", msg, details),
  conflict: (code: string, msg: string) => new AppError(409, code, msg),
  meetingEnded: () => new AppError(410, "MEETING_ENDED", "Meeting ini sudah berakhir."),
  meetingFull: () => new AppError(409, "MEETING_FULL", "Kapasitas meeting sudah penuh."),
  meetingLocked: () => new AppError(423, "MEETING_LOCKED", "Host mengunci meeting ini. Peserta baru tidak dapat masuk."),
  invitationInvalid: () => new AppError(404, "INVITATION_INVALID", "Tautan meeting tidak valid atau sudah dicabut."),
  invitationExpired: () => new AppError(410, "INVITATION_EXPIRED", "Tautan meeting sudah kedaluwarsa."),
  passcodeRequired: () => new AppError(401, "PASSCODE_REQUIRED", "Meeting ini memerlukan kode sandi."),
  passcodeInvalid: () => new AppError(401, "PASSCODE_INVALID", "Kode sandi salah."),
  removed: () => new AppError(403, "PARTICIPANT_REMOVED", "Anda telah dikeluarkan dari meeting ini oleh host."),
  rejected: () => new AppError(403, "PARTICIPANT_REJECTED", "Host menolak permintaan Anda untuk masuk."),
  consentRequired: () =>
    new AppError(
      428,
      "CONSENT_REQUIRED",
      "Meeting ini direkam atau ditranskripsi. Anda perlu menyetujui pemberitahuan untuk bergabung.",
    ),
  upstream: (code: string, msg: string) => new AppError(502, code, msg),
};
