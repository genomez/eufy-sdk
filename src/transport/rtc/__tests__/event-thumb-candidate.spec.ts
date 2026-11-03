import { EventEmitter } from "node:events";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import { RtcCommandRouter } from "../command-router.js";
import type { RtcSession, RtcSessionOptions } from "../session.js";
import { PtcsFramer, packetize } from "../ptcs-framer.js";
import { buildPortalHeader, parsePortalHeader } from "../portal-packet.js";

const ST = "T9000P0000000000",
  CAM = "T8425P0000000000";
const TABLE = "history_record_info";
const control = { kind: "set-payload" as const, cmd: 1224, payload: { mode_type: 1 }, channel: 0 };

class Session extends EventEmitter {
  connected = false;
  sent: Buffer[] = [];
  framer = new PtcsFramer();
  frameId = 0;
  ack = true;
  onSend?: (packet: Buffer) => void;
  async connect() {
    await this.framer.init(
      () => {},
      (frame, link) => this.emit("commandData", frame, link),
    );
    this.connected = true;
    this.emit("connected");
  }
  get isConnected() {
    return this.connected;
  }
  sendCommand(packet: Buffer) {
    this.sent.push(packet);
    if (this.ack)
      queueMicrotask(() => {
        const h = parsePortalHeader(packet)!;
        this.emit(
          "commandData",
          Buffer.concat([buildPortalHeader(h.commandId, 4, h.channel, h.segment, 1), Buffer.alloc(4)]),
          1,
        );
      });
    this.onSend?.(packet);
    return true;
  }
  fragments(
    body: unknown,
    {
      compressed = true,
      flag = true,
      bytes,
      payloadBytes = 1000,
      commandId = 1306,
      channel = 255,
      isResponse = 0,
      link = 2,
    }: {
      compressed?: boolean;
      flag?: boolean;
      bytes?: Buffer;
      payloadBytes?: number;
      commandId?: number;
      channel?: number;
      isResponse?: number;
      link?: number;
    } = {},
  ) {
    const json = Buffer.from(JSON.stringify(body));
    const packet = Buffer.concat([buildPortalHeader(commandId, json.length, channel, 0, isResponse), json]);
    const encoded = bytes ?? (compressed ? zstdCompressSync(packet) : packet);
    const packets = packetize(encoded, { channel: link, frameId: ++this.frameId, payloadBytes });
    if (compressed && flag) for (const p of packets) p.writeUInt16LE(p.readUInt16LE(18) | 0x0800, 18);
    return { encoded, packets, packet };
  }
  notify(body: unknown, options: Parameters<Session["fragments"]>[1] = {}) {
    const { encoded, packets } = this.fragments(body, options);
    for (const p of packets) this.framer.recvPacket(p);
    return encoded;
  }
  close() {
    this.connected = false;
    this.framer.destroy();
    this.emit("close");
  }
}

const routers: RtcCommandRouter[] = [];
afterEach(() => {
  for (const r of routers.splice(0)) r.close();
});
async function setup(extra: Record<string, unknown> = {}) {
  const sessions: Session[] = [];
  const onFrame = vi.fn();
  const devices = new Map<string, EufyDevice>([
    [ST, { sn: ST, stationSn: ST, model: "T9000", raw: {} } as EufyDevice],
    [CAM, { sn: CAM, stationSn: ST, model: "T8425", raw: { device_channel: 2 } } as EufyDevice],
  ]);
  let identity = { authToken: "synthetic", userId: "synthetic", accountUserId: "synthetic", gtoken: "synthetic" };
  const router = new RtcCommandRouter({
    identity: () => identity,
    accountName: () => "synthetic",
    shard: () => "us",
    findDevice: (sn) => devices.get(sn),
    onFrame,
    createSession: (_opts: RtcSessionOptions) => {
      const s = new Session();
      sessions.push(s);
      return s as unknown as RtcSession;
    },
    ...extra,
  });
  routers.push(router);
  await router.dispatchCommand(ST, control);
  const initialMetadata = onFrame.mock.calls.at(-1)![2];
  onFrame.mockClear();
  const s = sessions[0]!;
  s.sent.length = 0;
  return {
    router,
    s,
    sessions,
    onFrame,
    initialMetadata,
    changeOwner: () => {
      identity = { ...identity, userId: "changed" };
    },
  };
}
const request = (s: Session) => JSON.parse(s.sent[0]!.subarray(16).toString()).payload;
const response = (s: Session, extra: Record<string, unknown> = {}) => ({
  cmd: 10000,
  table: TABLE,
  transaction: request(s).transaction,
  count: 1,
  data: [
    { record_id: "synthetic-private", thumb_path: "synthetic-private", device_sn: "synthetic-private", duration: 5 },
  ],
  mIntRet: 0,
  start_id: 0,
  end_id: 1,
  msg: "synthetic-private",
  version: 1,
  ...extra,
});
async function started(s: Session) {
  await vi.waitFor(() => expect(s.sent.length).toBe(1), { interval: 1 });
}

import { validateThumbnail, selectThumbnail, thumbnailShapes } from "../event-thumb-candidate.js";

// Minimal structural JPEG, SOF0 3x2 with one component and an SOS segment.
const jpeg = Buffer.from("ffd8ffc0000b080002000301011100ffda0008010100003f0000ffd9", "hex");
const oldFile = "/synthetic/old.jpg",
  newFile = "/synthetic/new.jpg";
const rows = [
  { thumb_path: oldFile, start_time: "20261102000000" },
  { thumb_path: newFile, start_time: "20261103000000" },
  { thumb_path: "/synthetic/../invalid.jpg", start_time: "20261104000000" },
];
async function table(s: Session, extra: Record<string, unknown> = {}) {
  await started(s);
  s.notify(response(s, { data: rows, version: "1", ...extra }));
}
async function imageStarted(s: Session) {
  await vi.waitFor(() => expect(s.sent.length).toBe(2), { interval: 1 });
}
function image(s: Session, extra: Record<string, unknown> = {}, options: Parameters<Session["notify"]>[1] = {}) {
  s.notify({ file: newFile, content: jpeg.toString("base64"), ...extra }, { commandId: 1308, ...options });
}
describe("existing-owner stored thumbnail", () => {
  it("reports every row in at most four value-free shape classes and the other count", () => {
    const report = thumbnailShapes([
      { start_time: "Synthetic123", thumb_path: "/Synthetic123/folder 45.jpeg" },
      { start_time: "Different456", thumb_path: "/Different456/folder 67.JPEG" },
      ...["-", "/", ":", ".", "!"].map((part) => ({ start_time: part, thumb_path: part })),
    ]);
    expect(report.start_time.classes[0]).toEqual({ pattern: "aaaaaaaaa999", count: 2 });
    expect(report.thumb_path.classes[0]).toEqual({
      pattern: "/a9/a 9.a",
      count: 2,
      startsWithSlash: true,
      extension: "jpeg",
      byteLength: 28,
    });
    for (const bucket of Object.values(report)) {
      expect(bucket.classes).toHaveLength(4);
      expect(bucket.other).toBe(2);
      expect(bucket.classes.reduce((n: number, c: { count: number }) => n + c.count, bucket.other)).toBe(7);
      for (const c of bucket.classes) expect(c.pattern).not.toMatch(/[A-Zb-z0-8]/);
    }
    expect(JSON.stringify(report)).not.toMatch(/Synthetic|Different|123|456/);
  });
  it("caps path patterns at 64 without collapsing time runs, reports byte length and bounded extensions", () => {
    const long = "abc123/".repeat(80) + ".toolong";
    const report = thumbnailShapes([{ start_time: "Ab1234", thumb_path: long }, { thumb_path: "é.PNG" }, null]);
    expect(report.start_time.classes[0]?.pattern).toBe("aa9999");
    expect(report.thumb_path.classes[0]).toMatchObject({
      pattern: "a9/".repeat(21) + "a",
      extension: "other",
      startsWithSlash: false,
      byteLength: Buffer.byteLength(long),
    });
    expect(report.thumb_path.classes[1]).toMatchObject({ extension: "png", byteLength: 6 });
    expect(report.start_time.classes[1]).toEqual({ pattern: null, count: 2 });
  });
  it.each(["jpg", "jpeg", "png", "bmp", "dat", "bin"])("reports only the fixed %s extension category", (ext) => {
    expect(thumbnailShapes([{ thumb_path: "synthetic." + ext.toUpperCase() }]).thumb_path.classes[0]?.extension).toBe(
      ext,
    );
  });
  it.each(["ab123", "\u00e9\uff11\uff12", "toolong", "", "j!g"])(
    "masks arbitrary suffix content as other: %s",
    (ext) => {
      const report = thumbnailShapes([
        { start_time: "\u00e9\u03a9\u4e2d\u0661\uff12\u{1d7e1}!?@\\\tTZ", thumb_path: "../\u00e9\u0661." + ext },
      ]);
      expect(report.start_time.classes[0]?.pattern).toBe("???????????aa");
      expect(report.thumb_path.classes[0]?.extension).toBe("other");
      for (const bucket of Object.values(report))
        for (const shape of bucket.classes) expect(shape.pattern).not.toMatch(/[^a9?/\-_.:,+ ]/);
    },
  );
  it("keeps only permitted punctuation, maps T and Z as letters and absent suffix as none", () => {
    const report = thumbnailShapes([{ start_time: "/-_ .:,+TZ", thumb_path: "synthetic" }]);
    expect(report.start_time.classes[0]?.pattern).toBe("/-_ .:,+aa");
    expect(report.thumb_path.classes[0]?.extension).toBe("none");
  });
  it("prefers the largest integer record id over all times and allows firmware path forms", () => {
    expect(
      selectThumbnail([
        { thumb_path: "/new.jpg", record_id: 2, start_time: "20991103000000" },
        { thumb_path: "relative path/image.bin", record_id: 7, start_time: "unparseable" },
        { thumb_path: "/ignored.jpg", record_id: 6.5 },
        { thumb_path: "/ignored-time.jpg", start_time: "21001103000000" },
      ]),
    ).toBe("relative path/image.bin");
    expect(
      selectThumbnail([
        { thumb_path: "relative", record_id: -2 },
        { thumb_path: "other", record_id: -1 },
      ]),
    ).toBe("other");
  });
  it("falls back to parseable times only when no eligible path has an integer id", () => {
    expect(
      selectThumbnail([
        { thumb_path: "old", record_id: "99", start_time: "2026-11-02T00:00:00Z" },
        { thumb_path: "new", record_id: 1.5, start_time: "2026-11-03T00:00:00Z" },
        { thumb_path: "/../unsafe", record_id: 100 },
      ]),
    ).toBe("new");
    expect(selectThumbnail([{ thumb_path: "unknown", start_time: "unparseable" }, null])).toBeUndefined();
  });
  it.each([
    "",
    "../image",
    "folder/../image",
    "folder\\..\\image",
    "x\u0000y",
    "x\ny",
    "x\u007fy",
    "x\u0085y",
    "é".repeat(1025),
  ])("refuses an unsafe candidate without a fallback", (file) => {
    expect(selectThumbnail([{ thumb_path: file, record_id: 1 }])).toBeUndefined();
  });
  it("retains all-row shapes when no row qualifies and sends no image", async () => {
    const { router, s } = await setup();
    const run = router.readEventThumbnailCandidate(ST);
    await started(s);
    const data = [
      { thumb_path: "relative image", start_time: "unknown" },
      { thumb_path: "../\u00e9\u0661.ab123", start_time: "\u00e9\u0661", record_id: 99 },
    ];
    s.notify(response(s, { data }));
    expect(await run).toMatchObject({ outcome: "invalid_reply", shapes: thumbnailShapes(data), imageElapsedMs: null });
    expect(s.sent).toHaveLength(1);
  });
  it("sends one image using record id with an unparseable firmware time and retains shapes on image failure", async () => {
    const { router, s } = await setup();
    const run = router.readEventThumbnailCandidate(ST);
    await started(s);
    const data = [{ thumb_path: "relative firmware image", start_time: "unknown", record_id: 1 }];
    s.notify(response(s, { data }));
    await imageStarted(s);
    expect(JSON.parse(s.sent[1]!.subarray(16).toString()).payload).toEqual([{ file: "relative firmware image" }]);
    image(s, { file: "relative firmware image", content: "invalid" });
    expect(await run).toMatchObject({ outcome: "invalid_reply", shapes: thumbnailShapes(data) });
    expect(s.sent).toHaveLength(2);
  });
  it.each(["table", "image"])("rejects %s completion crossing its deadline during promise handoff", async (kind) => {
    const { router, s } = await setup();
    let now = performance.now();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const run = router.readEventThumbnailCandidate(ST);
      await started(s);
      s.notify(response(s, { data: rows }));
      if (kind === "table") now += 8001;
      else {
        await imageStarted(s);
        image(s);
        now += 8001;
      }
      const result = await run;
      expect(result.outcome).toBe("timeout");
      expect(result.jpeg).toBeUndefined();
      expect(s.sent).toHaveLength(kind === "table" ? 1 : 2);
    } finally {
      clock.mockRestore();
    }
  });
  it("accepts canonical base64 at the decoded cap, rejects one more byte and orders epoch string times", () => {
    const atCap = Buffer.concat([jpeg.subarray(0, -2), Buffer.alloc(262144 - jpeg.length), jpeg.subarray(-2)]);
    expect(validateThumbnail(atCap.toString("base64"))?.jpeg.length).toBe(262144);
    expect(validateThumbnail(Buffer.concat([atCap, Buffer.alloc(1)]).toString("base64"))).toBeUndefined();
    expect(
      selectThumbnail([
        { thumb_path: oldFile, start_time: "1762128000" },
        { thumb_path: newFile, start_time: "1762214400000" },
      ]),
    ).toBe(newFile);
    expect(selectThumbnail([{ thumb_path: newFile, start_time: "20269999000000" }])).toBeUndefined();
  });
  it.each(["table", "image", "total"])("enforces the absolute %s deadline without a late success", async (kind) => {
    const { router, s, onFrame } = await setup();
    let now = performance.now();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const run = router.readEventThumbnailCandidate(ST);
      await started(s);
      if (kind === "table") {
        now += 8001;
        s.notify(response(s, { data: rows }));
      } else {
        if (kind === "total") now += 7990;
        s.notify(response(s, { data: rows }));
        await imageStarted(s);
        now += kind === "total" ? 8011 : 8001;
        image(s);
      }
      const result = await run;
      expect(result.outcome).not.toBe("success");
      expect(result.jpeg).toBeUndefined();
      onFrame.mockClear();
      if (kind !== "table") {
        image(s);
        expect(onFrame).not.toHaveBeenCalled();
      }
      expect(s.sent).toHaveLength(kind === "table" ? 1 : 2);
    } finally {
      clock.mockRestore();
    }
  });
  it("sends the exact admitted table then exactly one image, selects newest valid path and returns only geometry and private bytes", async () => {
    const { router, s, onFrame } = await setup();
    const run = router.readEventThumbnailCandidate(ST);
    await table(s);
    await imageStarted(s);
    const body = JSON.parse(s.sent[1]!.subarray(16).toString());
    expect(body).toMatchObject({ cmd: 1308, mChannel: 255, payload: [{ file: newFile }] });
    expect(parsePortalHeader(s.sent[1]!)?.channel).toBe(255);
    image(s);
    const r = await run;
    expect(r).toMatchObject({
      outcome: "success",
      rowCount: 3,
      imageBytes: jpeg.length,
      jpegValid: true,
      width: 3,
      height: 2,
      tableResultCode: 0,
      imageResultCode: 0,
      ownerContinuous: true,
      generationContinuous: true,
      jpeg,
    });
    expect(r.elapsedMs).toBeLessThan(16000);
    expect(r.tableElapsedMs).toBeLessThan(8000);
    expect(r.imageElapsedMs).toBeLessThan(8000);
    expect(s.sent).toHaveLength(2);
    expect(onFrame.mock.calls.filter((c) => c[1].linkType === 2)).toHaveLength(0);
    const { jpeg: privateBytes, ...receipt } = r;
    expect(JSON.stringify(receipt)).not.toContain("synthetic");
  });
  it("wrong table transaction cannot start the image", async () => {
    const { router, s } = await setup();
    const run = router.readEventThumbnailCandidate(ST, { timeoutMs: 70 });
    await table(s, { transaction: "wrong" });
    expect((await run).outcome).toBe("ack_only/timeout");
    expect(s.sent).toHaveLength(1);
  });
  it.each(["file", "channel", "outer", "flag"])(
    "wrong image %s cannot satisfy the invocation and remains ordinary traffic",
    async (kind) => {
      const { router, s, onFrame } = await setup();
      const run = router.readEventThumbnailCandidate(ST, { timeoutMs: 80 });
      await table(s);
      await imageStarted(s);
      image(
        s,
        kind === "file" ? { file: oldFile } : {},
        kind === "channel"
          ? { channel: 0 }
          : kind === "outer"
            ? { commandId: 1103 }
            : kind === "flag"
              ? { isResponse: 1 }
              : {},
      );
      expect(["timeout", "ack_only/timeout"]).toContain((await run).outcome);
      expect(onFrame).toHaveBeenCalled();
      expect(s.sent).toHaveLength(2);
    },
  );
  it.each(["control", "live", "renewal", "refresh", "lease", "queued", "owner"])(
    "refuses image after %s intervenes between steps",
    async (kind) => {
      const { router, s, changeOwner } = await setup();
      const run = router.readEventThumbnailCandidate(ST);
      await started(s);
      const state = (router as any).sessions.get(ST);
      s.notify(response(s, { data: rows }));
      let controlRun: Promise<unknown> | undefined;
      if (kind === "control") controlRun = router.dispatchCommand(ST, control);
      if (kind === "live")
        controlRun = router
          .mediaProviderFor(CAM)
          .live()
          .then((viewer) => viewer.stop());
      if (kind === "renewal") state.refreshRetryAtMs = Date.now() + 7999;
      if (kind === "refresh") state.refreshPending = true;
      if (kind === "lease") state.leases++;
      if (kind === "queued") vi.spyOn(state.scheduler, "snapshot").mockReturnValue({ queued: 1 });
      if (kind === "owner") changeOwner();
      const result = await run;
      await controlRun;
      expect(result.outcome).not.toBe("success");
      expect(s.sent.filter((p) => JSON.parse(p.subarray(16).toString()).cmd === 1308)).toHaveLength(0);
    },
  );
  it("late exact image replies are suppressed; wrong paths are delivered; a later invocation cannot reuse the retained path", async () => {
    const { router, s, onFrame } = await setup();
    const abort = new AbortController();
    const run = router.readEventThumbnailCandidate(ST, { signal: abort.signal });
    await table(s);
    await imageStarted(s);
    abort.abort();
    expect((await run).outcome).toBe("abandoned");
    onFrame.mockClear();
    image(s);
    expect(onFrame).not.toHaveBeenCalled();
    image(s, { file: oldFile });
    expect(onFrame).toHaveBeenCalledTimes(1);
    await new Promise((r) => setImmediate(r));
    s.sent.length = 0;
    const next = router.readEventThumbnailCandidate(ST);
    await table(s);
    expect((await next).outcome).toBe("busy/not_admitted");
    expect(s.sent).toHaveLength(1);
  });
  it("owner change while waiting for the JPEG never returns image bytes", async () => {
    const { router, s, changeOwner } = await setup();
    const run = router.readEventThumbnailCandidate(ST);
    await table(s);
    await imageStarted(s);
    changeOwner();
    image(s);
    expect(await run).toMatchObject({ outcome: "owner_changed", jpegValid: false, imageBytes: null });
  });
  it.each(["base64", "padding", "soi", "eoi", "sof", "decoded-cap", "envelope-cap", "result"])(
    "rejects invalid image %s",
    async (kind) => {
      const { router, s } = await setup();
      const run = router.readEventThumbnailCandidate(ST);
      await table(s);
      await imageStarted(s);
      const bad = Buffer.from(jpeg);
      if (kind === "soi") bad[0] = 0;
      if (kind === "eoi") bad[bad.length - 1] = 0;
      if (kind === "sof") bad[8] = 0;
      const content =
        kind === "base64"
          ? "%%%="
          : kind === "padding"
            ? jpeg.toString("base64") + "="
            : kind === "decoded-cap"
              ? Buffer.alloc(262145).toString("base64")
              : bad.toString("base64");
      image(s, {
        content,
        ...(kind === "envelope-cap" ? { padding: "x".repeat(524288) } : {}),
        ...(kind === "result" ? { mIntRet: 7 } : {}),
      });
      const result = await run;
      expect(result.outcome).not.toBe("success");
      expect(result.jpeg).toBeUndefined();
      expect(s.sent).toHaveLength(2);
    },
  );
  it("matching cumulative image envelopes are bounded before ACK", async () => {
    const f = await setup();
    f.s.onSend = (p) => {
      if (JSON.parse(p.subarray(16).toString()).cmd === 1306) f.s.ack = false;
    };
    const second = f.router.readEventThumbnailCandidate(ST);
    await table(f.s);
    await imageStarted(f.s);
    image(f.s, { padding: "x".repeat(270000) });
    image(f.s, { padding: "x".repeat(270000) });
    expect((await second).outcome).toBe("receive_rejected");
  });
  it.each([{ data: [] }, { data: [{ thumb_path: "/synthetic/new.jpg", start_time: "invalid" }] }])(
    "does not fabricate a path for missing/invalid rows",
    async ({ data }) => {
      const { router, s } = await setup();
      const run = router.readEventThumbnailCandidate(ST);
      await table(s, { data });
      expect((await run).outcome).not.toBe("success");
      expect(s.sent).toHaveLength(1);
    },
  );
  it("validates geometry and rejects malformed segment bounds locally", () => {
    expect(validateThumbnail(jpeg.toString("base64"))).toMatchObject({ width: 3, height: 2 });
    const bad = Buffer.from(jpeg);
    bad.writeUInt16BE(65535, 4);
    expect(validateThumbnail(bad.toString("base64"))).toBeUndefined();
    expect(selectThumbnail(rows)).toBe(newFile);
  });
});
