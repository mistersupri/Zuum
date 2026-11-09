import { toast } from "sonner";
import { api, ApiError } from "./api";

// The server stores only a hash of each invitation token, so the URL can be shown
// once. We keep the latest one for this tab so the host can copy it again.
const key = (meetingId: string) => `zuum-invite:${meetingId}`;

export function rememberInvite(meetingId: string, url: string) {
  try {
    sessionStorage.setItem(key(meetingId), url);
  } catch {
    /* ignore */
  }
}

export async function copyInviteLink(meetingId: string, opts: { fresh?: boolean; rotate?: boolean } = {}) {
  let url: string | null = null;
  try {
    url = opts.fresh || opts.rotate ? null : sessionStorage.getItem(key(meetingId));
  } catch {
    url = null;
  }
  try {
    if (!url) {
      const res = await api<{ invitation: { url: string } }>(`/meetings/${meetingId}/invitations`, { body: { rotate: !!opts.rotate } });
      url = res.invitation.url;
      rememberInvite(meetingId, url);
    }
    await navigator.clipboard.writeText(url);
    toast.success(opts.rotate ? "Tautan lama dicabut. Tautan baru disalin." : "Tautan undangan disalin.");
    return url;
  } catch (err) {
    if (err instanceof ApiError) toast.error(err.message);
    else if (url) toast.message("Salin tautan ini secara manual", { description: url, duration: 15000 });
    else toast.error("Tautan gagal dibuat.");
    return url;
  }
}
