import { useCallback, useEffect, useRef, useState } from "react";

export interface DevicePrefs {
  micOn: boolean;
  camOn: boolean;
  audioInput?: string;
  videoInput?: string;
  audioOutput?: string;
}

const PREFS_KEY = "zuum-device-prefs";
export function loadPrefs(): DevicePrefs {
  try {
    return { micOn: true, camOn: true, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
  } catch {
    return { micOn: true, camOn: true };
  }
}
export function savePrefs(p: DevicePrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

export type PermissionState = "idle" | "asking" | "granted" | "denied" | "unavailable";

/** Local preview before joining: permission prompt, device lists, live mic level. */
export function usePreview(prefs: DevicePrefs) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [permission, setPermission] = useState<PermissionState>("idle");
  const [level, setLevel] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices());
    } catch {
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      setPermission("unavailable");
      return;
    }
    if (!prefs.micOn && !prefs.camOn) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setStream(null);
      return;
    }
    setPermission((p) => (p === "granted" ? p : "asking"));
    navigator.mediaDevices
      .getUserMedia({
        audio: prefs.micOn ? { deviceId: prefs.audioInput ? { exact: prefs.audioInput } : undefined, echoCancellation: true, noiseSuppression: true } : false,
        video: prefs.camOn ? { deviceId: prefs.videoInput ? { exact: prefs.videoInput } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = s;
        setStream(s);
        setPermission("granted");
        void refreshDevices();
      })
      .catch((err: DOMException) => {
        if (cancelled) return;
        setPermission(err.name === "NotAllowedError" || err.name === "SecurityError" ? "denied" : "unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [prefs.micOn, prefs.camOn, prefs.audioInput, prefs.videoInput, refreshDevices]);

  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  // Mic level meter so people can check their microphone works before entering.
  useEffect(() => {
    const track = stream?.getAudioTracks()[0];
    if (!track) return setLevel(0);
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let raf = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      void ctx.close();
    };
  }, [stream]);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  return { stream, devices, permission, level, stop };
}
