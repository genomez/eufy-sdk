import { appendFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEventTableRequest } from "../event-table-candidate.js";
import { parsePortalHeader } from "../portal-packet.js";
import { recordingFixture, row, scope, sent } from "./recordings-fixture.js";
import type { RtcCommandRouter } from "../command-router.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  appendFileSync: vi.fn(),
}));

let router: RtcCommandRouter | undefined;
afterEach(() => {
  router?.close();
  router = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const request = (packet: Buffer) => JSON.parse(packet.subarray(16).toString());
const personLines = () =>
  vi.mocked(appendFileSync).mock.calls.filter(([, line]) => String(line).includes("event_person_list row keys"));

describe("event person table probe", () => {
  it("builds only the nested bounded FULL_TABLE read with the established station envelope", () => {
    const packet = buildEventTableRequest(
      "synthetic-account",
      7,
      "synthetic-transaction",
      100,
      undefined,
      "event_person_list",
    );
    expect(parsePortalHeader(packet)).toMatchObject({ commandId: 1350, channel: 255, segment: 7, isResponse: 0 });
    expect(request(packet)).toEqual({
      account_id: "synthetic-account",
      cmd: 1306,
      mChannel: 255,
      mValue3: 0,
      payload: {
        cmd: 10000,
        table: "event_person_list",
        transaction: "synthetic-transaction",
        payload: {
          count: 100,
          start_date: "",
          end_date: "",
          start_id: 0,
          end_id: 1,
          flag: 0,
          need_ai: 1,
          res_unzip: 1,
          update_time: "0",
          start_time: "0",
          alarm_id: "",
        },
      },
    });
  });

  it("defaults off after an event-table read", async () => {
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", undefined);
    const f = await recordingFixture();
    router = f.router;
    const read = router.readRecordingCatalog(scope);
    await sent(f.session);
    f.session.table([row()]);
    expect((await read).status).toBe("ok");
    await tick();
    expect(f.session.sent).toHaveLength(1);
    expect(personLines()).toHaveLength(0);
  });

  it("reads once per session, correlates the table and transaction, and logs only count and key shape", async () => {
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "1");
    vi.stubEnv("EUFY_EVENT_ROW_KEYS_FILE", "synthetic-row-keys.log");
    const f = await recordingFixture();
    router = f.router;
    const read = router.readRecordingCatalog(scope);
    await sent(f.session);
    f.session.table([row()]);
    expect((await read).status).toBe("ok");
    await sent(f.session, 2);
    const probe = request(f.session.sent[1]!);
    expect(probe.payload).toMatchObject({ table: "event_person_list", cmd: 10000, payload: { count: 100 } });
    f.onFrame.mockClear();
    const reply = {
      cmd: 10000,
      transaction: probe.payload.transaction,
      table: "event_person_list",
      mIntRet: 0,
      data: [{ record_id: 71, person_id: "synthetic-person", name: "synthetic-name" }],
    };
    f.session.notify({ ...reply, transaction: "unrelated" });
    f.session.notify({ ...reply, table: "history_record_info" });
    expect(personLines()).toHaveLength(0);
    f.onFrame.mockClear();
    f.session.notify(reply);
    await tick();
    expect(personLines()).toEqual([
      [
        "synthetic-row-keys.log",
        "[rtc] event_person_list row keys rows=1 name:stringx1 person_id:stringx1 record_id:numberx1\n",
        { mode: 0o600 },
      ],
    ]);
    expect(f.onFrame).not.toHaveBeenCalled();
    f.advance(61_000);
    const second = router.readRecordingCatalog(scope);
    await sent(f.session, 3);
    f.session.table([row({ record_id: 2 })]);
    expect((await second).status).toBe("ok");
    await tick();
    expect(f.session.sent).toHaveLength(3);
  });

  it("logs an empty table and isolates append failure from the completed catalog", async () => {
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "1");
    const f = await recordingFixture();
    router = f.router;
    const read = router.readRecordingCatalog(scope);
    await sent(f.session);
    f.session.table([]);
    expect((await read).status).toBe("ok");
    await sent(f.session, 2);
    vi.mocked(appendFileSync).mockImplementationOnce(() => {
      throw new Error("synthetic append failure");
    });
    f.session.table([], { table: "event_person_list" });
    await tick();
    expect(personLines().at(-1)?.[1]).toBe("[rtc] event_person_list row keys rows=0 \n");
    expect(f.session.sent).toHaveLength(2);
  });

  it("never acquires a session after the catalog owner closes", async () => {
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "1");
    const f = await recordingFixture();
    router = f.router;
    const read = router.readRecordingCatalog(scope);
    await sent(f.session);
    f.session.table([row()]);
    await read;
    f.session.close();
    await tick();
    expect(f.session.sent).toHaveLength(1);
    expect(f.session.isConnected).toBe(false);
  });

  it("times out after two seconds without retrying or blocking later catalog reads", async () => {
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "1");
    const f = await recordingFixture();
    router = f.router;
    const read = router.readRecordingCatalog(scope);
    await sent(f.session);
    f.session.table([row()]);
    expect((await read).status).toBe("ok");
    await sent(f.session, 2);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    f.advance(61_000);
    const second = router.readRecordingCatalog(scope);
    await sent(f.session, 3);
    f.session.table([row({ record_id: 2 })]);
    expect((await second).status).toBe("ok");
    await tick();
    expect(f.session.sent).toHaveLength(3);
  });
});
