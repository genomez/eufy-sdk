import { EventEmitter } from "node:events";
import type { LiveAudioFrame, LiveStreamHandle, LiveVideoFrame, MediaFragment } from "../../../core/contracts.js";
import { FragmentRecording } from "../fragment-recording.js";
import { SharedLiveSource } from "../shared-live-source.js";

class FakeStream extends EventEmitter implements LiveStreamHandle {
  stopped = 0;

  start(): this {
    return this;
  }

  stop(): void {
    this.stopped++;
  }

  video(frame: LiveVideoFrame): void {
    this.emit("video", frame);
  }

  audio(frame: LiveAudioFrame): void {
    this.emit("audio", frame);
  }
}

function video(keyframe: boolean, byte = keyframe ? 0x65 : 0x21): LiveVideoFrame {
  const parameterSets = keyframe ? [Buffer.from([0x67, 0x42, 0xc0, 0x1e]), Buffer.from([0x68, 0xce, 0x3c, 0x80])] : [];
  const nals = [...parameterSets, Buffer.from([byte, 1, 2, 3])];
  return {
    keyframe,
    width: 1280,
    height: 720,
    codec: "h264",
    data: Buffer.concat(nals.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), nal])),
  };
}

function audio(payload: Buffer): LiveAudioFrame {
  const length = payload.length + 7;
  return {
    codec: "aac-lc",
    data: Buffer.concat([
      Buffer.from([
        0xff,
        0xf1,
        0x60,
        0x40 | ((length >> 11) & 0x03),
        (length >> 3) & 0xff,
        ((length & 0x07) << 5) | 0x1f,
        0xfc,
      ]),
      payload,
    ]),
  };
}

function source(options: ConstructorParameters<typeof SharedLiveSource>[0] = { makeStream: () => new FakeStream() }) {
  let stream!: FakeStream;
  const shared = new SharedLiveSource({
    ...options,
    makeStream: () => (stream = new FakeStream()),
  });
  return { shared, stream: () => stream };
}

describe("FragmentRecording", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("replays timestamped prebuffer before live A/V and releases its consumer on return", async () => {
    const { shared, stream } = source({ makeStream: () => new FakeStream(), preBufferSeconds: 10 });
    const keeper = shared.attach();
    vi.setSystemTime(1000);
    stream().video(video(true));
    vi.setSystemTime(1064);
    stream().audio(audio(Buffer.from([0x11, 0x22])));
    vi.setSystemTime(1128);
    stream().video(video(false));

    const recording = new FragmentRecording(Promise.resolve(shared), { fragmentSeconds: 0, preBufferSeconds: 10 });
    const iterator = recording[Symbol.asyncIterator]();
    const init = await iterator.next();
    expect(init.value?.init?.includes(Buffer.from("mp4a"))).toBe(true);

    vi.setSystemTime(1192);
    stream().video(video(true));
    const media = await iterator.next();
    expect(media.value?.data.includes(Buffer.from("moof"))).toBe(true);
    await iterator.return?.();
    expect(shared.consumerCount).toBe(1);
    keeper.detach();
  });

  it("forwards the shared battery notice so the recording owner can extend", async () => {
    const { shared, stream } = source({
      makeStream: () => new FakeStream(),
      powered: "battery",
      batteryBudgetMs: 100,
      budgetGraceMs: 50,
    });
    const recording = new FragmentRecording(Promise.resolve(shared));
    let notices = 0;
    recording.on("budget", (notice) => {
      notices++;
      notice.extend();
    });
    await Promise.resolve();
    stream().video(video(true));
    vi.advanceTimersByTime(150);
    expect(notices).toBe(1);
    expect(stream().stopped).toBe(0);
    recording.stop();
    expect(shared.consumerCount).toBe(0);
  });

  it("holds its consumer instead of muxing fragments its owner is not taking", async () => {
    const { shared, stream } = source({ makeStream: () => new FakeStream(), maxQueue: 20 });
    const recording = new FragmentRecording(Promise.resolve(shared), { fragmentSeconds: 0 });
    await Promise.resolve();

    let at = 1000;
    for (let index = 0; index < 400; index++) {
      vi.setSystemTime((at += 64));
      stream().video(video(true));
    }

    recording.stop();
    const fragments: MediaFragment[] = [];
    for await (const fragment of recording) {
      fragments.push(fragment);
    }

    expect(fragments.length).toBeGreaterThan(0);
    expect(fragments.length).toBeLessThan(20);
  });
});
