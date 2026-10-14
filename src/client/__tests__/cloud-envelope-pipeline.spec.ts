import { expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { PushClient } from "../../transport/push/push-client.js";
import { mcsRoot } from "../../transport/push/proto.js";
import { MessageTag } from "../../transport/push/message-tags.js";
import type { McsParser } from "../../transport/push/parser.js";

const camera = "T8000P0000000001",
  hub = "T8000P0000000000",
  time = 1790741400000;
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0xff, 0xd9]);
function setup() {
  const client = new EufyMega({ email: "test@example.com", password: "synthetic", autoRealtime: false, pollMs: 0 });
  const internal = client as any;
  internal.registry.devices = [
    { sn: hub, model: "T9000", raw: {} },
    { sn: camera, model: "T8214", stationSn: hub, raw: { parent_sn: hub, device_channel: 0 } },
  ];
  vi.spyOn(internal.mega, "auth", "get").mockReturnValue({ userId: "synthetic-account" });
  internal.mega.downloadImage = vi.fn(async () => jpeg);
  const push = new PushClient({
    fid: "synthetic",
    androidId: "1",
    securityToken: "2",
    fcmToken: "synthetic",
    createdAt: 0,
  });
  push.on("push", (event) => internal.onCloudPush(event));
  const parser = (push as unknown as { parser: McsParser }).parser;
  let first = true;
  const send = (
    extra: Record<string, unknown> = {},
    envelopeClock: string | null = String(time),
    claims: Record<string, string> = {},
  ) => {
    const body = {
      device_sn: camera,
      event_type: 3102,
      pic_url: "https://example.test/paired-image",
      create_time: time - 7000,
      trigger_time: time - 7000,
      ...extra,
    };
    const encoded = Buffer.concat([Buffer.from(JSON.stringify(body)), Buffer.from([0])]).toString("base64");
    const bytes = mcsRoot()
      .lookupType("mcs_proto.DataMessageStanza")
      .encodeDelimited({
        from: "synthetic",
        category: "synthetic",
        appData: [
          { key: "payload", value: encoded },
          ...(envelopeClock === null ? [] : [{ key: "event_time", value: envelopeClock }]),
          { key: "station_sn", value: hub },
          ...Object.entries(claims).map(([key, value]) => ({ key, value })),
        ],
      })
      .finish();
    parser.handleData(
      Buffer.concat([Buffer.from(first ? [41, MessageTag.DataMessageStanza] : [MessageTag.DataMessageStanza]), bytes]),
    );
    first = false;
  };
  return { client, internal, push, send };
}

it("carries a sibling event time from MCS through facade admission into the exact stored image", async () => {
  const { client, internal, push, send } = setup();
  try {
    send();
    await vi.waitFor(() => expect(internal.mega.downloadImage).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      await expect(internal.storedImages.snapshotStored(camera)).resolves.toEqual({ jpeg, eventTime: time });
    });
    expect(client.getEventRoutingDiagnostics().recent[0]).toMatchObject({
      source: "cloud_push",
      envelopeTimeMs: time,
      createTimeMs: time - 7000,
      triggerTimeMs: time - 7000,
    });
  } finally {
    push.close();
    await client.disconnect();
  }
});

it("accepts a later explicit name without assigning it to a newer unnamed detection", async () => {
  const { client, push, send } = setup();
  const names: Array<unknown> = [];
  client.on("personDetected", (event) => names.push(event.person_name));
  try {
    send();
    send({ person_name: "Synthetic One" });
    send();
    expect(names).toEqual([undefined, "Synthetic One", undefined]);
    const evidence = client.getEventRoutingDiagnostics();
    expect(evidence.recent.map((row) => row.derivedNamePresent)).toEqual([false, true, false]);
    expect(JSON.stringify(evidence)).not.toContain("Synthetic One");
  } finally {
    push.close();
    await client.disconnect();
  }
});

it("retains consensus source time with the exact JPEG after delayed acquisition", async () => {
  const { client, internal, push, send } = setup();
  let release!: (bytes: Buffer) => void;
  internal.mega.downloadImage = vi.fn(
    () =>
      new Promise<Buffer>((resolve) => {
        release = resolve;
      }),
  );
  try {
    send({ session_id: "synthetic-event" }, null);
    await vi.waitFor(() => expect(internal.mega.downloadImage).toHaveBeenCalledTimes(1));
    await expect(internal.storedImages.snapshotStored(camera)).rejects.toMatchObject({ reason: "pending" });
    release(jpeg);
    await vi.waitFor(async () => {
      await expect(internal.storedImages.snapshotStored(camera)).resolves.toEqual({ jpeg, eventTime: time - 7000 });
    });
    expect(client.getThumbnailDiagnostics().counters).toMatchObject({
      envelope_missing: 1,
      candidate_valid: 1,
      normalization_gained: 1,
      retention_preserved: 1,
    });
  } finally {
    push.close();
    await client.disconnect();
  }
});

it("does not replace a malformed envelope clock with consensus during image admission", async () => {
  const { client, internal, push, send } = setup();
  try {
    send({ session_id: "synthetic-event" }, "invalid");
    await vi.waitFor(async () => {
      await expect(internal.storedImages.snapshotStored(camera)).resolves.toEqual({ jpeg });
    });
    expect(client.getThumbnailDiagnostics().counters).toMatchObject({ envelope_invalid: 1, candidate_missing: 1 });
  } finally {
    push.close();
    await client.disconnect();
  }
});

it("does not admit a consensus-dated thumbnail with conflicting camera claims", async () => {
  const { client, internal, push, send } = setup();
  try {
    send({ session_id: "synthetic-event" }, null, { device_sn: "other-synthetic-camera" });
    expect(client.getThumbnailDiagnostics().counters.non_device).toBe(1);
    expect(internal.mega.downloadImage).not.toHaveBeenCalled();
  } finally {
    push.close();
    await client.disconnect();
  }
});
