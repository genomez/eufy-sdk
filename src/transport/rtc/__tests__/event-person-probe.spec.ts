import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEventTableRequest } from "../event-table-candidate.js";
import { parsePortalHeader } from "../portal-packet.js";
import { recordingFixture, RecordingSession, row, scope, sent, station, control } from "./recordings-fixture.js";
import type { RtcSession } from "../session.js";
import type { RtcCommandRouter } from "../command-router.js";
import type { EventTableReceipt } from "../event-table-candidate.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, appendFileSync: vi.fn(original.appendFileSync) };
});

let router: RtcCommandRouter | undefined;
const routers: RtcCommandRouter[] = [];
let fixture: typeof recordingFixture;
let directory: string;
let logFile: string;
beforeEach(async () => {
  vi.resetModules();
  vi.mocked(appendFileSync).mockReset();
  vi.mocked(appendFileSync).mockImplementation(
    (await vi.importActual<typeof import("node:fs")>("node:fs")).appendFileSync,
  );
  directory = mkdtempSync(join(tmpdir(), "eufy-person-probe-"));
  logFile = join(directory, "keys.log");
  vi.stubEnv("EUFY_EVENT_ROW_KEYS_FILE", logFile);
  fixture = (await import("./recordings-fixture.js")).recordingFixture;
});
afterEach(async () => {
  vi.useRealTimers();
  router?.close();
  for (const owner of routers.splice(0)) owner.close();
  await tick();
  router = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const request = (packet: Buffer) => JSON.parse(packet.subarray(16).toString());
const personLines = () =>
  vi.mocked(appendFileSync).mock.calls.filter(([, line]) => String(line).includes("event_person_list row keys"));
const logLines = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trimEnd().split("\n") : []);
const outcomes = () => logLines().filter((line) => line.includes("event_person_list probe outcome="));
const isoPrefix = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;
const invokeProbe = (target: RtcCommandRouter, owner = Reflect.get(target, "sessions").get(station)) =>
  Reflect.get(target, "probeEventPersons").call(target, station, owner);
const skipped = (reason: string) => logLines().filter((line) => line.endsWith(`probe skipped reason=${reason}`));

describe("event person table probe", () => {
  it("logs the real catalog trigger once for reads without rows and once when armed", async () => {
    const f = await fixture();
    router = f.router;
    f.session.accept = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await router.readRecordingCatalog(scope)).toMatchObject({ status: "unavailable", reason: "send_refused" });
      f.advance(61_000);
    }
    expect(logLines().filter((line) => line.endsWith("probe trigger_skipped reason=no_event_rows"))).toHaveLength(1);
    expect(logLines().filter((line) => line.endsWith("probe armed"))).toHaveLength(0);
    expect(outcomes()).toHaveLength(0);
    f.session.accept = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const read = router.readRecordingCatalog(scope);
      await sent(f.session, attempt === 0 ? 3 : 5);
      f.session.table([row()]);
      expect((await read).status).toBe("ok");
      if (attempt === 0) {
        await sent(f.session, 4);
        f.session.table([], { table: "event_person_list" });
      }
      await tick();
      f.advance(61_000);
    }
    expect(logLines().filter((line) => line.endsWith("probe armed"))).toHaveLength(1);
    expect(outcomes()).toHaveLength(1);
  });

  it("caps refunded outcome volume across routers and preserves later non-refunded outcomes", async () => {
    const f = await fixture();
    router = f.router;
    const other = await fixture();
    routers.push(other.router);
    const owner = Reflect.get(router, "sessions").get(station);
    const otherOwner = Reflect.get(other.router, "sessions").get(station);
    owner.leases++;
    otherOwner.leases++;
    for (let attempt = 0; attempt < 70; attempt++) {
      invokeProbe(attempt % 2 ? other.router : router);
      await tick();
    }
    expect(outcomes()).toHaveLength(50);
    expect(
      outcomes().every((line) => line.includes("refusal=leases") && line.endsWith("refunded=true attempt=1/3")),
    ).toBe(true);
    expect(logLines().filter((line) => line.endsWith("probe refunded_lines_suppressed after=50"))).toHaveLength(1);
    owner.leases--;
    otherOwner.leases--;
    invokeProbe(router);
    await sent(f.session);
    f.session.table([], { table: "event_person_list" });
    await tick();
    expect(outcomes()).toHaveLength(51);
    expect(outcomes().at(-1)).toMatch(/outcome=empty .*refunded=false attempt=1\/3$/);
  });

  it.each(["leases", "pending_exchanges", "information_tainted", "renewal_soon", "owner_not_continuous"] as const)(
    "logs the first failing refusal code for %s without consuming the attempt",
    async (cause) => {
      const f = await fixture();
      router = f.router;
      const owner = Reflect.get(router, "sessions").get(station);
      if (cause === "leases") {
        owner.leases = 1;
        owner.pendingExchanges = 1;
      } else if (cause === "pending_exchanges") owner.pendingExchanges = 1;
      else if (cause === "information_tainted") {
        owner.informationTainted = true;
        owner.leases = 1;
      } else if (cause === "renewal_soon") owner.refreshRetryAtMs = Date.now() + 8_000;
      else f.changeAccount();
      invokeProbe(router);
      await tick();
      expect(outcomes()).toEqual([
        expect.stringMatching(new RegExp(`outcome=busy/not_admitted refusal=${cause} .*refunded=true attempt=1/3$`)),
      ]);
      expect(f.session.sent).toHaveLength(0);
      owner.leases = 0;
      owner.pendingExchanges = 0;
    },
  );

  it.each(["aborted", "run_gate", "owner_not_continuous", "live_view", "reply_table_full"] as const)(
    "retains refusal diagnostics when the scheduler run gate fails with %s",
    async (cause) => {
      const f = await fixture();
      router = f.router;
      const owner = Reflect.get(router, "sessions").get(station);
      vi.spyOn(owner.scheduler, "enqueue").mockImplementationOnce(async (input) => {
        const job = input as { run: () => Promise<EventTableReceipt> };
        if (cause === "aborted") Reflect.get(router!, "eventPersonProbes").get(station).controller.abort();
        else if (cause === "run_gate") f.advance(2_000);
        else if (cause === "owner_not_continuous") owner.generation++;
        else if (cause === "live_view") Reflect.get(router!, "lives").has = () => true;
        else
          for (let i = 0; i < 16; i++)
            Reflect.get(router!, "eventTableReplies").set(`synthetic-${i}`, { expiresAtMs: Infinity });
        return job.run();
      });
      invokeProbe(router);
      await tick();
      expect(outcomes()).toEqual([expect.stringContaining(`outcome=busy/not_admitted refusal=${cause} `)]);
      expect(outcomes()[0]).toMatch(/refunded=true attempt=1\/3$/);
      expect(f.session.sent).toHaveLength(0);
      expect(owner.leases).toBe(0);
      expect(owner.pendingExchanges).toBe(0);
    },
  );

  it("keeps refusal fields absent for non-person callers", async () => {
    const f = await fixture();
    router = f.router;
    const owner = Reflect.get(router, "sessions").get(station);
    owner.leases++;
    const receipt = await Reflect.get(router, "readEventCandidate").call(router, station, {});
    expect(receipt.outcome).toBe("busy/not_admitted");
    expect(receipt).not.toHaveProperty("refusal");
    owner.leases--;
  });

  it("logs result_nonzero without row values or a refund", async () => {
    const f = await fixture();
    router = f.router;
    invokeProbe(router);
    await sent(f.session);
    f.session.table([{ name: "synthetic-private-value" }], { table: "event_person_list", mIntRet: 7 });
    await tick();
    expect(outcomes()).toEqual([
      expect.stringMatching(/outcome=result_nonzero .*rows=null resultCode=7 .*refunded=false attempt=1\/3$/),
    ]);
    expect(personLines()).toHaveLength(0);
    expect(readFileSync(logFile, "utf8")).not.toContain("synthetic-private-value");
  });

  it("preserves an abandoned receipt and its refund when every diagnostic write fails", async () => {
    vi.stubEnv("EUFY_EVENT_ROW_KEYS_FILE", directory);
    const f = await fixture();
    router = f.router;
    const readCandidate = vi.fn(Reflect.get(router, "readEventCandidate").bind(router));
    Reflect.set(router, "readEventCandidate", readCandidate);
    invokeProbe(router);
    await sent(f.session);
    const probe = Reflect.get(router, "eventPersonProbes").get(station);
    router.preemptRecordingReads();
    await probe.finished;
    await tick();
    await expect(readCandidate.mock.results[0]!.value).resolves.toMatchObject({ outcome: "abandoned" });
    expect(Reflect.get(router, "eventPersonProbes").size).toBe(0);
    expect(Reflect.get(router, "sessions").get(station)).toMatchObject({ leases: 0, pendingExchanges: 0 });
    vi.stubEnv("EUFY_EVENT_ROW_KEYS_FILE", logFile);
    invokeProbe(router);
    await sent(f.session, 2);
    f.session.table([], { table: "event_person_list" });
    await tick();
    expect(outcomes()).toEqual([expect.stringMatching(/outcome=empty .*refunded=false attempt=1\/3$/)]);
    expect(logLines().filter((line) => line.endsWith("probe eligible"))).toHaveLength(1);
  });

  it("summarizes changed skip and refund counters at most hourly without a background timer", async () => {
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "0");
    const f = await fixture();
    router = f.router;
    vi.useFakeTimers({ toFake: ["Date"] });
    const epoch = Date.now();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now() - epoch + 161_000);
    const summaries = () => logLines().filter((line) => line.includes("probe skip_counts "));
    invokeProbe(router);
    invokeProbe(router);
    expect(summaries()).toEqual([
      expect.stringMatching(
        /disabled=1 attempt_cap=0 owner_changed=0 session_already_probed=0 no_event_rows=0 refunded=0$/,
      ),
    ]);
    vi.advanceTimersByTime(3_599_999);
    invokeProbe(router);
    expect(summaries()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    invokeProbe(router);
    expect(summaries()).toHaveLength(2);
    expect(summaries()[1]).toMatch(/disabled=4 /);
    vi.advanceTimersByTime(3_600_000);
    expect(summaries()).toHaveLength(2);
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "1");
    const owner = Reflect.get(router, "sessions").get(station);
    owner.leases++;
    invokeProbe(router);
    await tick();
    expect(summaries()).toHaveLength(3);
    expect(summaries()[2]).toMatch(/refunded=1$/);
    owner.leases--;
  });

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
      expect(outcomes().filter((line) => line.includes("outcome=abandoned"))).toEqual([
        expect.stringMatching(/refunded=true attempt=1\/3$/),
      ]);
    },
  );

  it("gives back a pre-empted attempt so the same session can probe again later", async () => {
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "1");
    const f = await fixture();
    router = f.router;
    const first = router.readRecordingCatalog(scope);
    await sent(f.session);
    f.session.table([row()]);
    expect((await first).status).toBe("ok");
    await sent(f.session, 2);
    const probe = Reflect.get(router, "eventPersonProbes").get(station);
    router.preemptRecordingReads();
    await probe.finished;
    await tick();
    f.advance(61_000);
    const second = router.readRecordingCatalog(scope);
    await sent(f.session, 3);
    f.session.table([row({ record_id: 2 })]);
    expect((await second).status).toBe("ok");
    await sent(f.session, 4);
    expect(request(f.session.sent[3]!).payload.table).toBe("event_person_list");
    f.session.table([], { table: "event_person_list" });
    await tick();
    expect(personLines()).toHaveLength(1);
  });

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
    invokeProbe(other.router);
    invokeProbe(router);
    expect(skipped("attempt_cap")).toHaveLength(1);
    expect(outcomes()).toHaveLength(3);
    expect(outcomes().map((line) => line.match(/attempt=\d\/3$/)?.[0])).toEqual([
      "attempt=1/3",
      "attempt=2/3",
      "attempt=3/3",
    ]);
    expect(logLines().filter((line) => line.endsWith("probe eligible"))).toHaveLength(1);
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
    invokeProbe(router);
    const other = await fixture();
    routers.push(other.router);
    invokeProbe(other.router);
    expect(skipped("disabled")).toHaveLength(1);
    expect(outcomes()).toHaveLength(0);
  });

  it("reads once per session, correlates the table and transaction, and logs only count and key shape", async () => {
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "1");
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
        logFile,
        expect.stringMatching(
          /Z \[rtc\] event_person_list row keys rows=1 extra:stringx1 name:stringx1 people:objectx1 person_id:stringx1 record_id:numberx1\n$/,
        ),
        { mode: 0o600 },
      ],
    ]);
    expect(outcomes()).toEqual([
      expect.stringMatching(
        /Z \[rtc\] event_person_list probe outcome=success elapsedMs=0 rows=1 resultCode=0 compressedBytes=null decompressedBytes=\d+ ownerContinuous=true generationContinuous=true refunded=false attempt=1\/3$/,
      ),
    ]);
    expect(logLines().every((line) => isoPrefix.test(line))).toBe(true);
    for (const [path, line, options] of vi.mocked(appendFileSync).mock.calls)
      if (String(line).includes("event_person_list")) {
        expect(path).toBe(logFile);
        expect(options).toEqual({ mode: 0o600 });
      }
    for (const value of [
      station,
      "synthetic-camera-0",
      "synthetic-account",
      "synthetic-person",
      "synthetic-name",
      "synthetic_person",
      logFile,
    ])
      expect(readFileSync(logFile, "utf8")).not.toContain(value);
    expect(f.onFrame).not.toHaveBeenCalled();
    f.advance(61_000);
    const second = router.readRecordingCatalog(scope);
    await sent(f.session, 3);
    f.session.table([row({ record_id: 2 })]);
    expect((await second).status).toBe("ok");
    await tick();
    expect(f.session.sent).toHaveLength(3);
    invokeProbe(router);
    invokeProbe(router);
    expect(skipped("session_already_probed")).toHaveLength(1);
    expect(outcomes()).toHaveLength(1);
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
    expect(personLines().at(-1)?.[1]).toMatch(/Z \[rtc\] event_person_list row keys rows=0 \n$/);
    expect(outcomes()).toEqual([expect.stringContaining("outcome=empty elapsedMs=0 rows=0 resultCode=0")]);
    expect(f.session.sent).toHaveLength(2);
  });

  it("logs each non-admitted attempt once and retains refunds and eligibility across routers", async () => {
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "1");
    const f = await fixture();
    router = f.router;
    const owner = Reflect.get(router, "sessions").get(station);
    owner.leases++;
    for (let attempt = 0; attempt < 2; attempt++) {
      invokeProbe(router);
      await tick();
    }
    owner.leases--;
    expect(outcomes()).toEqual([
      expect.stringMatching(
        /probe outcome=busy\/not_admitted refusal=leases elapsedMs=0 rows=null resultCode=null compressedBytes=null decompressedBytes=0 ownerContinuous=true generationContinuous=true refunded=true attempt=1\/3$/,
      ),
      expect.stringMatching(/probe outcome=busy\/not_admitted .* refunded=true attempt=1\/3$/),
    ]);
    expect(f.session.sent).toHaveLength(0);
    invokeProbe(router);
    await sent(f.session);
    f.session.table([], { table: "event_person_list" });
    await tick();
    expect(outcomes()).toHaveLength(3);
    expect(outcomes()[2]).toMatch(/outcome=empty .* refunded=false attempt=1\/3$/);
    expect(personLines()).toHaveLength(1);
    const other = await fixture();
    routers.push(other.router);
    invokeProbe(other.router);
    await sent(other.session);
    other.session.table([], { table: "event_person_list" });
    await tick();
    expect(outcomes()[3]).toMatch(/outcome=empty .* attempt=2\/3$/);
    invokeProbe(router);
    invokeProbe(other.router);
    invokeProbe(other.router);
    expect(skipped("session_already_probed")).toHaveLength(1);
    expect(logLines().filter((line) => line.endsWith("probe eligible"))).toHaveLength(1);
  });

  it("logs only the rejection constructor once without refunding the attempt", async () => {
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "1");
    const f = await fixture();
    router = f.router;
    const error = new TypeError(`${station} synthetic-account ${logFile}`);
    error.name = "synthetic-account";
    const read = vi.fn<() => Promise<EventTableReceipt>>().mockRejectedValue(error);
    Reflect.set(router, "readEventCandidate", read);
    invokeProbe(router);
    await tick();
    invokeProbe(router);
    await tick();
    expect(read).toHaveBeenCalledExactlyOnceWith(station, { timeoutMs: 2000 }, undefined, true);
    expect(outcomes()).toEqual([expect.stringMatching(/probe outcome=error errorName=TypeError attempt=1\/3$/)]);
    expect(skipped("session_already_probed")).toHaveLength(1);
    const text = readFileSync(logFile, "utf8");
    for (const value of [station, "synthetic-account", logFile, error.message]) expect(text).not.toContain(value);
  });

  it("isolates an unwritable log path from successful empty reads and settled outcomes", async () => {
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "1");
    vi.stubEnv("EUFY_EVENT_ROW_KEYS_FILE", directory);
    const f = await fixture();
    router = f.router;
    const readCandidate = vi.fn(Reflect.get(router, "readEventCandidate").bind(router));
    Reflect.set(router, "readEventCandidate", readCandidate);
    const read = router.readRecordingCatalog(scope);
    await sent(f.session);
    f.session.table([row()]);
    expect((await read).status).toBe("ok");
    await sent(f.session, 2);
    f.session.table([], { table: "event_person_list" });
    await tick();
    expect(readCandidate).toHaveBeenCalledTimes(1);
    await expect(readCandidate.mock.results[0]!.value).resolves.toMatchObject({ outcome: "empty", rowCount: 0 });
    expect(Reflect.get(router, "eventPersonProbes").size).toBe(0);
    expect(Reflect.get(router, "eventTableProbes").size).toBe(0);
    expect(personLines()).toHaveLength(1);
    const failedWrites = vi
      .mocked(appendFileSync)
      .mock.calls.flatMap(([path], index) =>
        path === directory ? [vi.mocked(appendFileSync).mock.results[index]!.type] : [],
      );
    expect(failedWrites).toEqual(["throw", "throw", "throw", "throw", "throw"]);
    vi.stubEnv("EUFY_EVENT_ROW_KEYS_FILE", logFile);
    invokeProbe(router);
    expect(skipped("session_already_probed")).toHaveLength(1);
    expect(readCandidate).toHaveBeenCalledTimes(1);
  });

  it("never acquires a session after the catalog owner closes", async () => {
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "1");
    const f = await fixture();
    router = f.router;
    const read = router.readRecordingCatalog(scope);
    await sent(f.session);
    f.session.table([row()]);
    await read;
    const owner = Reflect.get(router, "sessions").get(station);
    f.session.close();
    await tick();
    invokeProbe(router, owner);
    const other = await fixture();
    routers.push(other.router);
    invokeProbe(other.router, owner);
    expect(skipped("owner_changed")).toHaveLength(1);
    expect(outcomes()).toHaveLength(0);
    expect(f.session.sent).toHaveLength(1);
    expect(f.session.isConnected).toBe(false);
  });

  it.each([true, false])(
    "times out after two seconds without retrying or blocking later catalog reads (ack=%s)",
    async (ack) => {
      vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "1");
      const f = await fixture();
      router = f.router;
      const read = router.readRecordingCatalog(scope);
      await sent(f.session);
      f.session.table([row()]);
      expect((await read).status).toBe("ok");
      f.session.ack = ack;
      await sent(f.session, 2);
      await new Promise((resolve) => setTimeout(resolve, 2100));
      expect(outcomes()).toEqual([
        expect.stringMatching(
          new RegExp(
            `probe outcome=${ack ? "ack_only/timeout" : "timeout"} elapsedMs=0 rows=null resultCode=null compressedBytes=null decompressedBytes=0 ownerContinuous=true generationContinuous=true refunded=false attempt=1/3$`,
          ),
        ),
      ]);
      f.session.ack = true;
      f.advance(61_000);
      const second = router.readRecordingCatalog(scope);
      await sent(f.session, 3);
      f.session.table([row({ record_id: 2 })]);
      expect((await second).status).toBe("ok");
      await tick();
      expect(f.session.sent).toHaveLength(3);
    },
  );
});
