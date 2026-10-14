import { expect, it } from "vitest";
import { EventRoutingRecorder } from "../event-routing-diagnostics.js";

it("bounds observations, discards arbitrary fields and returns detached snapshots", () => {
  const recorder = new EventRoutingRecorder();
  const payload = {
    person_name: "Synthetic private value",
    nick_name: "Synthetic nickname",
    person_id: 123456,
    device_sn: "T8000P0000000001",
    account: "synthetic account",
    event_type: 3111,
  };
  for (let n = 0; n < 110; n++) recorder.record("rtc", "mapped", "T8425", payload, [{ payload }], 2037);
  const snapshot = recorder.diagnostics();
  expect(snapshot).toMatchObject({ total: 110, evicted: 14 });
  expect(snapshot.recent).toHaveLength(96);
  expect(snapshot.recent[0]).toMatchObject({
    namePresent: true,
    nicknamePresent: true,
    personIdPresent: true,
    derivedNamePresent: true,
  });
  const encoded = JSON.stringify(snapshot);
  for (const forbidden of [
    payload.person_name,
    payload.nick_name,
    String(payload.person_id),
    payload.device_sn,
    payload.account,
  ])
    expect(encoded).not.toContain(forbidden);
  snapshot.recent[0]!.model = "mutated";
  snapshot.recent.length = 0;
  expect(recorder.diagnostics().recent[0]!.model).toBe("T8425");
  expect(recorder.diagnostics().recent).toHaveLength(96);
});

it("does not retain malformed model/event values or count unrelated frames", () => {
  const recorder = new EventRoutingRecorder();
  recorder.record("rtc", "ignored", "T8425", {});
  expect(recorder.diagnostics().total).toBe(0);
  recorder.record(
    "rtc",
    "invalid_event_type",
    "T8425-private-suffix",
    { event_type: "Synthetic private value", person_id: -1, nick_name: " " },
    [],
    999,
  );
  expect(recorder.diagnostics().recent[0]).toMatchObject({
    model: null,
    eventCode: null,
    envelopeCode: null,
    personIdPresent: false,
    nicknamePresent: false,
  });
  expect(JSON.stringify(recorder.diagnostics())).not.toContain("private");
});
