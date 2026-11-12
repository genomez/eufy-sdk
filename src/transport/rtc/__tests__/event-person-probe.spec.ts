import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEventTableRequest } from "../event-table-candidate.js";
import { parsePortalHeader } from "../portal-packet.js";
import { recordingFixture, RecordingSession, row, scope, sent, station, control } from "./recordings-fixture.js";
import type { RtcSession } from "../session.js";
import type { RtcCommandRouter } from "../command-router.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  appendFileSync: vi.fn(),
}));

let router: RtcCommandRouter | undefined;
const routers: RtcCommandRouter[] = [];
let fixture: typeof recordingFixture;
beforeEach(async () => {
  vi.resetModules();
  fixture = (await import("./recordings-fixture.js")).recordingFixture;
});
afterEach(() => {
  router?.close();
  for (const owner of routers.splice(0)) owner.close();
  router = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const request = (packet: Buffer) => JSON.parse(packet.subarray(16).toString());
const personLines = () =>
  vi.mocked(appendFileSync).mock.calls.filter(([, line]) => String(line).includes("event_person_list row keys"));

describe("event person table probe", () => {
  it("is enabled by default when the environment variable is unset", async () => {
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", undefined);
    const f = await fixture();
    router = f.router;
    const read = router.readRecordingCatalog(scope);
    await sent(f.session);
    f.session.table([row()]);
    expect((await read).status).toBe("ok");
    await sent(f.session, 2);
    expect(request(f.session.sent[1]!).payload.table).toBe("event_person_list");
    f.session.table([], { table: "event_person_list" });
    await tick();
  });

  it("wires catalog rows, timezone and station to the injected numeric diagnostic writer", async () => {
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "0");
    const { EventRowCodeDiagnostic, eventRowCodes } = await import("../event-row-codes.js");
    const lines: string[] = [];
    const diagnostic = new EventRowCodeDiagnostic((line) => lines.push(line));
    const write = vi.spyOn(eventRowCodes, "writeRows").mockImplementation(diagnostic.writeRows.bind(diagnostic));
    const f = await fixture({ recordingTimeZone: "UTC" });
    router = f.router;
    const read = router.readRecordingCatalog(scope);
    await sent(f.session);
    const rows = [row({ trigger_type: 3102, person_id: 42, str_extra: '{"video_type":2,"face_id":43}' })];
    f.session.table(rows);
    expect((await read).status).toBe("ok");
    expect(write).toHaveBeenCalledExactlyOnceWith(rows, "UTC", station);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        record_id: 1,
        start_time: Date.UTC(2026, 9, 20, 12) / 1000,
        camera_index: 0,
        codes: { event_type: 3, detect_type: 4, trigger_type: 3102 },
        str_extra: { video_type: 2 },
      },
    ]);
  });

  it.each(["preemptRecordingReads", "refreshInformation", "cover", "catalog", "continuation"] as const)(
    "yields its active exchange immediately when %s begins",
    async (operation) => {
      vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "1");
      const f = await fixture();
      router = f.router;
      const first = router.readRecordingCatalog(scope);
      await sent(f.session);
      f.session.table(
        Array.from({ length: 20 }, (_, i) => row({ record_id: 100 - i, thumb_path: `/synthetic/cover-${i}.jpg` })),
        {
          version: "1",
          count: 20,
          start_id: 100,
          end_id: 81,
        },
      );
      const result = await first;
      if (result.status !== "ok") throw new Error("synthetic catalog unavailable");
      f.advance(61_000);
      await sent(f.session, 2);
      const probe = Reflect.get(router, "eventPersonProbes").get(station);
      const owner = Reflect.get(router, "sessions").get(station);
      expect(probe.controller.signal.aborted).toBe(false);
      expect(owner.pendingExchanges).toBe(1);
      expect(router.informationRefreshReady(station)).toBe(true);
      if (operation === "preemptRecordingReads") {
        router.preemptRecordingReads();
        expect(probe.controller.signal.aborted).toBe(true);
        await probe.finished;
        await tick();
        expect(owner.leases).toBe(0);
        expect(owner.pendingExchanges).toBe(0);
        expect(f.session.sent).toHaveLength(2);
      } else if (operation === "refreshInformation") {
        const read = router.refreshInformation(station);
        expect(probe.controller.signal.aborted).toBe(true);
        await read;
        expect(f.session.sent).toHaveLength(3);
        expect(parsePortalHeader(f.session.sent[2]!)?.commandId).toBe(1103);
      } else {
        const read =
          operation === "cover"
            ? router.readRecordingCover(scope, result.rows[0]!.coverSelector!)
            : router.readRecordingCatalog(scope, operation === "continuation" ? { beforeRecordId: 81 } : {});
        expect(probe.controller.signal.aborted).toBe(true);
        await sent(f.session, 3);
        if (operation === "cover")
          f.session.notify({ file: result.rows[0]!.coverSelector!.thumbPath, content: "/9j/2Q==" }, 1308);
        else f.session.table([row({ record_id: 80 })]);
        expect((await read).status).toBe("ok");
      }
      expect(Reflect.get(router, "eventPersonProbes").size).toBe(0);
      expect(Reflect.get(router, "eventTableProbes").size).toBe(0);
      expect(personLines()).toHaveLength(0);
    },
  );

  it("limits attempts across replacement sessions and new routers to three for the process", async () => {
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "1");
    const f = await fixture();
    router = f.router;
    let session = f.session;
    Reflect.get(router, "deps").createSession = () => {
      session = new RecordingSession();
      return session as unknown as RtcSession;
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) {
        session.close();
        await router.dispatchCommand(station, control);
        await router.refreshInformation(station);
        f.advance(61_000);
        session.sent.length = 0;
      }
      const read = router.readRecordingCatalog(scope);
      await sent(session);
      session.table([row()]);
      expect((await read).status).toBe("ok");
      if (attempt < 3) {
        await sent(session, 2);
        session.table([], { table: "event_person_list" });
      }
      await tick();
      expect(session.sent).toHaveLength(attempt < 3 ? 2 : 1);
    }
    const other = await fixture();
    routers.push(other.router);
    const read = other.router.readRecordingCatalog(scope);
    await sent(other.session);
    other.session.table([row()]);
    expect((await read).status).toBe("ok");
    await tick();
    expect(other.session.sent).toHaveLength(1);
  });

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

  it("can be turned off with EUFY_EVENT_PERSON_PROBE=0", async () => {
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "0");
    const f = await fixture();
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
    const f = await fixture();
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
      data: [
        {
          record_id: 71,
          person_id: "synthetic-person",
          name: "synthetic-name",
          people: { synthetic_person: 42 },
          extra: '{"synthetic_name":43}',
        },
      ],
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
        "[rtc] event_person_list row keys rows=1 extra:stringx1 name:stringx1 people:objectx1 person_id:stringx1 record_id:numberx1\n",
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
    const f = await fixture();
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
    const f = await fixture();
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
    const f = await fixture();
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
