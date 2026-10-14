import type { Readable } from "node:stream";
import { LiveSnapshotUnavailableError } from "../../core/contracts.js";
import type { Logger } from "../../core/logger.js";
import { spawnFfmpeg, type FfmpegLevel } from "../ffmpeg.js";
import { jpegGeometry } from "../p2p/media.js";

/** Decode one HEVC still, bounding acquisition and decode under the request's lifetime. */
export async function rtcSnapshot(
  open: (signal: AbortSignal) => Promise<Readable>,
  opts: { signal?: AbortSignal; timeoutMs?: number; executable?: string; level?: FfmpegLevel; logger?: Logger },
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  opts.signal?.throwIfAborted();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)
    throw new RangeError("RTC snapshot timeout must be an integer from 1 to 60000ms");
  const deadline = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(
    () => deadline.abort(new LiveSnapshotUnavailableError("no-keyframe", `no keyframe decoded within ${timeoutMs}ms`)),
    timeoutMs,
  );
  let readable: Readable | undefined;
  try {
    readable = await open(signal);
    signal.throwIfAborted();
    const ff = spawnFfmpeg(["-f", "hevc", "-i", "pipe:0", "-frames:v", "1", "-f", "image2", "pipe:1"], {
      executable: opts.executable,
      level: opts.level,
      logger: opts.logger,
    });
    const jpeg = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0,
        settled = false,
        closed = false;
      const releaseErrors = () => {
        readable!.off("error", onError);
        ff.stdin?.off("error", onError);
        ff.stdout?.off("error", onError);
        ff.stderr?.off("error", onError);
        ff.off("error", onError);
      };
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        ff.stdout?.off("data", onData);
        readable!.unpipe(ff.stdin!);
        ff.stdin?.destroy();
        ff.stdout?.destroy();
        ff.stderr?.destroy();
        if (!closed) {
          try {
            ff.kill("SIGKILL");
          } catch (killError) {
            error ??= killError;
          }
        }
        if (error !== undefined) reject(error);
        else if (bytes) resolve(Buffer.concat(chunks));
        else reject(new LiveSnapshotUnavailableError("undecodable-burst", "ffmpeg produced no image"));
      };
      const onAbort = () => finish(signal.reason);
      const onError = (error: Error) => finish(error);
      const onData = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024)
          finish(new LiveSnapshotUnavailableError("undecodable-burst", "decoded image exceeds size limit"));
        else chunks.push(chunk);
      };
      const onClose = () => {
        closed = true;
        finish();
        releaseErrors();
        ff.off("close", onClose);
      };
      readable!.on("error", onError);
      ff.stdin?.on("error", onError);
      ff.stdout?.on("error", onError);
      ff.stderr?.on("error", onError);
      ff.stdout?.on("data", onData);
      ff.on("error", onError);
      ff.on("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      else readable!.pipe(ff.stdin!);
    });
    const geometry = jpegGeometry(jpeg);
    if (!geometry) throw new LiveSnapshotUnavailableError("undecodable-burst", "decoded image has no JPEG geometry");
    return { jpeg, ...geometry };
  } finally {
    clearTimeout(timer);
    readable?.destroy();
  }
}
