import nodemailer from "nodemailer";
import { config } from "../config";

const transport = config.SMTP_URL ? nodemailer.createTransport(config.SMTP_URL) : null;

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends mail through SMTP when configured. In development without SMTP the
 * mail body is printed to stdout so the reset/verification link can be used
 * locally. In production without SMTP nothing containing a token is logged.
 */
export async function sendMail(mail: Mail, log: { info: (o: object, m: string) => void; warn: (m: string) => void }) {
  if (transport) {
    await transport.sendMail({ from: config.MAIL_FROM, ...mail });
    return;
  }
  if (config.NODE_ENV === "development") {
    log.info({ to: mail.to, subject: mail.subject }, `[dev-mail]\n${mail.text}`);
    return;
  }
  log.warn("SMTP_URL belum dikonfigurasi; email tidak terkirim.");
}
