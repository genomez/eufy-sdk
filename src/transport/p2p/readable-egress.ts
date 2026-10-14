/**
 * Readable egress — mint a `node:stream` Readable over a {@link Consumer} of a {@link SharedLiveSource}.
 *
 * This is the in-process pull surface: the Readable can be piped anywhere a `node:stream` goes, without
 * touching the P2P internals. Backpressure is honored — when the Readable's internal buffer fills, the
 * consumer is paused; the consumer's own bounded queue then applies the V2 drop-to-keyframe policy if
 * the sink stays slow, so one stuck reader never stalls the shared upstream or its peers. Destroying the
 * Readable detaches the consumer (refcount--).
 *
 * Two modes: raw Annex-B **bytes** (default) or **objectMode** {@link LiveVideoFrame}s, which carry the
 * codec/keyframe metadata per access unit.
 *
 * @module p2p/readable-egress
 */
import { Readable } from "node:stream";
import type { Consumer } from "./shared-live-source.js";
import type { LiveVideoFrame } from "../../core/contracts.js";

export interface ReadableEgressOptions {
  /** Emit {@link LiveVideoFrame} objects instead of raw Annex-B bytes (default false = bytes). */
  objectMode?: boolean;
  /** Readable highWaterMark (bytes, or object count in objectMode). */
  highWaterMark?: number;
}

/**
 * Wrap a shared-source {@link Consumer} in a fresh Readable. The consumer is detached when the
 * Readable is destroyed/ended, so callers own the lifetime by owning the stream.
 */
export function openReadableFromConsumer(consumer: Consumer, opts: ReadableEgressOptions = {}): Readable {
  const objectMode = opts.objectMode ?? false;

  const readable = new Readable({
    objectMode,
    highWaterMark: opts.highWaterMark,
    // Pull-driven: resume the consumer when the sink wants more.
    read() {
      consumer.resume();
    },
    destroy(err, cb) {
      consumer.detach();
      cb(err);
    },
  });

  const onVideo = (frame: LiveVideoFrame) => {
    // push() returns false when the internal buffer is full — pause the consumer so its bounded
    // queue (and drop-to-keyframe) takes over until the next read() resumes us.
    const ok = readable.push(objectMode ? frame : frame.data);
    if (!ok) consumer.pause();
  };
  consumer.on("video", onVideo);

  consumer.on("stop", () => readable.push(null)); // upstream ended → EOF
  consumer.on("error", (err: Error) => readable.destroy(err));

  return readable;
}
