import { createHash, randomBytes, randomInt } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

/** 256-bit url-safe token. Used for invitations, refresh tokens and reset links. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Tokens are high-entropy, so a plain SHA-256 is enough for lookup-by-hash storage. */
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// algorithm 2 = Argon2id (the package exports it as a const enum, unusable with isolatedModules).
const ARGON_OPTS = { algorithm: 2 as const, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (password: string) => hash(password, ARGON_OPTS);
export const verifyPassword = async (hashed: string, password: string) => {
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
};

// Meeting codes are for typing, not for security: access still needs an invitation,
// membership, or the waiting room. Alphabet skips look-alike characters.
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function meetingCode() {
  const pick = (n: number) => Array.from({ length: n }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  return `${pick(3)}-${pick(4)}-${pick(3)}`;
}

export const identityFor = {
  user: (userId: string) => `u_${userId}`,
  guest: () => `g_${randomBytes(9).toString("base64url")}`,
};
