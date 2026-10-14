import { EventRoutingRecorder } from "../event-routing-diagnostics.js";
import { EufyMega } from "../eufy-mega.js";
import { normalizePushEvent } from "../../transport/push/push-client.js";

describe("notification timing evidence", () => {
  it("keeps source clocks separate and strips all payload identities", () => {
    const recorder = new EventRoutingRecorder();
    recorder.record("rtc", "mapped", "T8214", {
      event_type: 3102,
      create_time: "1790000000",
      trigger_time: 1790000001000,
      event_time: "bad",
      pic_url: "https://example.invalid/private-marker",
      objects: { names: ["private-marker"] },
      pic_content: { person_id: "private-marker" },
      session_id: "private-marker",
      private: "private-marker",
    });
    const row = recorder.diagnostics().recent[0]!;
    expect(row).toMatchObject({
      envelopeTimeMs: null,
      eventTimeMs: null,
      createTimeMs: 1790000000000,
      triggerTimeMs: 1790000001000,
      thumbnailPresent: true,
      objectsNamesPresent: true,
      picContentPresent: true,
      eventIdentityPresent: true,
    });
    expect(JSON.stringify(row)).not.toContain("private-marker");
    row.createTimeMs = 0;
    expect(recorder.diagnostics().recent[0]!.createTimeMs).toBe(1790000000000);
  });
  it.each([null, 0, -1, Infinity, NaN, {}, [], true, "1790000000oops", "1790000000.5"])(
    "rejects malformed time %j",
    (value) => {
      const recorder = new EventRoutingRecorder();
      recorder.record("rtc", "mapped", "T8214", { create_time: value });
      expect(recorder.diagnostics().recent[0]!.createTimeMs).toBeNull();
    },
  );
  it("bounds records and does not interpret arbitrary nested data as names", () => {
    const recorder = new EventRoutingRecorder();
    for (let i = 0; i < 110; i++)
      recorder.record("rtc", "mapped", "T8214", { objects: ["private-marker"], pic_content: null });
    expect(recorder.diagnostics().recent).toHaveLength(96);
    expect(recorder.diagnostics().evicted).toBe(14);
    expect(recorder.diagnostics().recent[0]).toMatchObject({ objectsNamesPresent: false, picContentPresent: false });
  });
  it("observes real facade RTC and cloud entry paths without selecting a nested time", async () => {
    const hub = "T8000P0000000000",
      camera = "T8000P0000000001";
    const client = new EufyMega({
      email: "test@example.com",
      password: "synthetic",
      autoRealtime: false,
      pollMs: 0,
      storedSnapshotCache: false,
    });
    const internal = client as any;
    internal.registry.devices = [
      { sn: hub, model: "T9000", raw: {} },
      { sn: camera, model: "T8214", stationSn: hub, raw: { parent_sn: hub, device_channel: 0 } },
    ];
    const payload = {
      device_sn: camera,
      event_type: 3102,
      create_time: 1790000000,
      trigger_time: 1790000001,
      pic_url: "https://example.invalid/image",
    };
    internal.onRtcFrame(hub, {
      commandId: 1351,
      channel: 255,
      segment: 1,
      isResponse: 0,
      linkType: 3,
      cmd: 2037,
      data: { cmd: 2037, payload },
    });
    const cloud = normalizePushEvent({ payload: { payload } });
    expect(cloud.thumbnailCandidate?.eventTime).toBeUndefined();
    internal.onCloudPush(cloud);
    const rows = client.getEventRoutingDiagnostics().recent;
    expect(rows.map((row) => row.source)).toEqual(["rtc", "cloud_push"]);
    for (const row of rows)
      expect(row).toMatchObject({ createTimeMs: 1790000000000, triggerTimeMs: 1790000001000, envelopeTimeMs: null });
    internal.onCloudPush(normalizePushEvent({ payload: { event_time: "1790000002", payload } }));
    expect(client.getEventRoutingDiagnostics().recent[2]!.envelopeTimeMs).toBe(1790000002000);
    await client.disconnect();
  });
});
