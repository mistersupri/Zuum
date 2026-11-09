import { SignJWT, jwtVerify } from "jose";
import { config } from "../config";

const key = new TextEncoder().encode(config.JWT_SECRET);
const ISSUER = "zuum-api";

export interface UserClaims {
  typ: "user";
  sub: string;
}

/** Guest sessions are scoped to one participant of one meeting. */
export interface GuestClaims {
  typ: "guest";
  sub: string; // participantId
  mid: string; // meetingId
}

export type Claims = UserClaims | GuestClaims;

export async function signAccessToken(userId: string) {
  return new SignJWT({ typ: "user" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key);
}

export async function signGuestToken(participantId: string, meetingId: string) {
  return new SignJWT({ typ: "guest", mid: meetingId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(participantId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${config.GUEST_TOKEN_TTL_SECONDS}s`)
    .sign(key);
}

export async function verifyToken(token: string): Promise<Claims | null> {
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ["HS256"] });
    if (payload.typ === "user" && payload.sub) return { typ: "user", sub: payload.sub };
    if (payload.typ === "guest" && payload.sub && typeof payload.mid === "string")
      return { typ: "guest", sub: payload.sub, mid: payload.mid };
    return null;
  } catch {
    return null;
  }
}
