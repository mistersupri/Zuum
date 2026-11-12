import { describe, expect, it } from "vitest";
import { browserLivekitUrl, livekitUrlProblems } from "../src/lib/livekit-url";

describe("browserLivekitUrl", () => {
  it("turns a path into wss:// on an https app (e.g. behind Cloudflare Tunnel)", () => {
    expect(browserLivekitUrl("/livekit", "https://zuum.example.id")).toBe("wss://zuum.example.id/livekit");
    expect(browserLivekitUrl("/livekit/", "https://zuum.example.id/")).toBe("wss://zuum.example.id/livekit");
  });
  it("uses ws:// with the port on a plain http app", () => {
    expect(browserLivekitUrl("/livekit", "http://localhost:8080")).toBe("ws://localhost:8080/livekit");
  });
  it("passes absolute URLs through unchanged", () => {
    expect(browserLivekitUrl("wss://media.example.id", "https://zuum.example.id")).toBe("wss://media.example.id");
  });
});

describe("livekitUrlProblems", () => {
  it("flags ws:// on an https app (the CSP / mixed-content error)", () => {
    const p = livekitUrlProblems("ws://192.168.1.20:7880", "https://zuum.example.id");
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("tidak terenkripsi");
  });
  it("flags a cross-host ws:// URL on an http app", () => {
    expect(livekitUrlProblems("ws://localhost:7880", "http://localhost:8080")).toHaveLength(1);
  });
  it("accepts the recommended and the separate-TLS-host setups", () => {
    expect(livekitUrlProblems("/livekit", "https://zuum.example.id")).toEqual([]);
    expect(livekitUrlProblems("/livekit", "http://localhost:8080")).toEqual([]);
    expect(livekitUrlProblems("wss://media.example.id", "https://zuum.example.id")).toEqual([]);
  });
});
