import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEventTableRequest, EVENT_TABLE_BYTE_CAP } from "../event-table-candidate.js";
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
  vi
    .mocked(appendFileSync)
    .mock.calls.filter(
      ([, line]) => String(line).includes("person_probe table=") && String(line).includes(" row keys "),
    );
const logLines = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trimEnd().split("\n") : []);
const outcomes = () => logLines().filter((line) => line.includes("person_probe table=") && line.includes(" outcome="));
const isoPrefix = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;
const invokeProbe = (target: RtcCommandRouter, owner = Reflect.get(target, "sessions").get(station)) =>
  Reflect.get(target, "probeEventPersons").call(target, station, owner);
const skipped = (reason: string) => logLines().filter((line) => line.endsWith(`person_probe skipped reason=${reason}`));

describe("event person table probe", () => {
  it("moves from a refused roster to crop success and rejects mismatched tables on both paths", async () => {
    for (const table of ["person_basic_info", "record_crop_picture_info"] as const) {
      const f = await fixture();
      routers.push(f.router);
      invokeProbe(f.router);
      await sent(f.session);
      const probe = request(f.session.sent[0]!).payload;
      expect(probe.table).toBe(table);
      expect(Reflect.get(f.router, "eventTableReplies").get(probe.transaction).table).toBe(table);
      for (const wrongTable of [
        "history_record_info",
        "event_person_list",
        table === "person_basic_info" ? "record_crop_picture_info" : "person_basic_info",
      ])
        f.session.table([{ name: "synthetic-wrong-table-value" }], { table: wrongTable });
      await tick();
      expect(outcomes()).toHaveLength(table === "person_basic_info" ? 0 : 1);
      expect(personLines()).toHaveLength(0);
      f.session.table([{ person_id: "synthetic-crop-person", record_id: 71 }], {
        table,
        mIntRet: table === "person_basic_info" ? -6001 : 0,
      });
      await tick();
      invokeProbe(f.router);
      expect(f.session.sent).toHaveLength(1);
    }
    expect(outcomes()).toEqual([
      expect.stringMatching(
        /table=person_basic_info outcome=result_nonzero .*rows=null resultCode=-6001 .*refunded=false attempt=1\/3$/,
      ),
      expect.stringMatching(
        /table=record_crop_picture_info outcome=success .*rows=1 resultCode=0 .*refunded=false attempt=1\/3$/,
      ),
    ]);
    expect(personLines()).toHaveLength(1);
    expect(readFileSync(logFile, "utf8")).not.toContain("synthetic-wrong-table-value");
  });

  it("refunds pre-emption and idle refusal to their own tables and skips an exhausted table", async () => {
    const f = await fixture();
    router = f.router;
    invokeProbe(router);
    await sent(f.session);
    const probe = Reflect.get(router, "eventPersonProbes").get(station);
    router.preemptRecordingReads();
    await probe.finished;
    await tick();
    const owner = Reflect.get(router, "sessions").get(station);
    owner.leases++;
    invokeProbe(router);
    await tick();
    owner.leases--;
    expect(outcomes()).toEqual([
      expect.stringMatching(/table=person_basic_info outcome=abandoned .*refunded=true attempt=1\/3$/),
      expect.stringMatching(
        /table=record_crop_picture_info outcome=busy\/not_admitted refusal=leases .*refunded=true attempt=1\/3$/,
      ),
    ]);
    for (let attempt = 0; attempt < 6; attempt++) {
      const next = await fixture();
      routers.push(next.router);
      if (attempt < 3) {
        const nextOwner = Reflect.get(next.router, "sessions").get(station);
        nextOwner.leases++;
        invokeProbe(next.router);
        await tick();
        nextOwner.leases--;
      }
      invokeProbe(next.router);
      await sent(next.session);
      const table = attempt < 3 ? "record_crop_picture_info" : "person_basic_info";
      expect(request(next.session.sent[0]!).payload.table).toBe(table);
      next.session.table([], { table });
      await tick();
      expect(outcomes().at(-1)).toMatch(
        new RegExp(`table=${table} outcome=empty .*refunded=false attempt=${(attempt % 3) + 1}/3$`),
      );
    }
    invokeProbe(router);
    expect(skipped("attempt_cap")).toHaveLength(1);
  });

  it("keeps the rotation cursor after a refund and ignores a late roster reply during the crop probe", async () => {
    const f = await fixture();
    router = f.router;
    invokeProbe(router);
    await sent(f.session);
    const roster = request(f.session.sent[0]!).payload;
    expect(roster.table).toBe("person_basic_info");
    const probe = Reflect.get(router, "eventPersonProbes").get(station);
    router.preemptRecordingReads();
    await probe.finished;
    await tick();
    expect(outcomes()).toEqual([
      expect.stringMatching(/table=person_basic_info outcome=abandoned .*refunded=true attempt=1\/3$/),
    ]);
    invokeProbe(router);
    await sent(f.session, 2);
    const crop = request(f.session.sent[1]!).payload;
    expect(crop.table).toBe("record_crop_picture_info");
    expect(crop.transaction).not.toBe(roster.transaction);
    f.onFrame.mockClear();
    f.session.table([{ name: "synthetic-late-private" }], {
      table: roster.table,
      transaction: roster.transaction,
    });
    await tick();
    expect(outcomes()).toHaveLength(1);
    expect(personLines()).toHaveLength(0);
    expect(Reflect.get(router, "eventPersonProbes").size).toBe(1);
    expect(f.onFrame).not.toHaveBeenCalled();
    f.session.table([], { table: crop.table });
    await tick();
    expect(outcomes().at(-1)).toMatch(/table=record_crop_picture_info outcome=empty .*attempt=1\/3$/);
    const next = await fixture();
    routers.push(next.router);
    invokeProbe(next.router);
    await sent(next.session);
    expect(request(next.session.sent[0]!).payload.table).toBe("person_basic_info");
    next.session.table([], { table: "person_basic_info" });
    await tick();
    expect(outcomes().at(-1)).toMatch(/table=person_basic_info outcome=empty .*attempt=1\/3$/);
    expect(readFileSync(logFile, "utf8")).not.toContain("synthetic-late-private");
  });

  it("consumes oversized attempts without key lines and halves only that table's next count to a floor of five", async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const f = await fixture();
      routers.push(f.router);
      invokeProbe(f.router);
      await sent(f.session);
      const table = attempt % 2 ? "record_crop_picture_info" : "person_basic_info";
      const count = [100, 20, 50, 10, 25, 5][attempt]!;
      expect(request(f.session.sent[0]!).payload).toMatchObject({ table, payload: { count } });
      f.session.table([{ face_data: "x".repeat(EVENT_TABLE_BYTE_CAP) }], { table });
      await tick();
      expect(outcomes()).toHaveLength(attempt + 1);
      expect(outcomes().at(-1)).toMatch(
        new RegExp(
          `table=${table} outcome=receive_rejected .*rows=null .*count=${count} .*refunded=false attempt=${Math.floor(attempt / 2) + 1}/3$`,
        ),
      );
      expect(personLines()).toHaveLength(0);
      expect(Reflect.get(f.router, "eventPersonProbes").size).toBe(0);
      invokeProbe(f.router);
      expect(f.session.sent).toHaveLength(1);
    }
    const final = await fixture();
    routers.push(final.router);
    invokeProbe(final.router);
    await tick();
    expect(final.session.sent).toHaveLength(0);
    expect(skipped("attempt_cap")).toHaveLength(1);
    expect(personLines()).toHaveLength(0);
  });

  it("keeps roster and crop names, ids, paths, encoded data and data-keyed maps out of the file", async () => {
    const secrets = [
      "Synthetic Ada Example",
      "synthetic-person-id-927451",
      "https://example.invalid/private/face-927451.jpg",
      "/synthetic/private/face-927451.jpg",
      "U3ludGhldGljUHJpdmF0ZUZhY2VCaXRz",
      "AdaExample",
      "ada_example",
      "nested_private_identity",
      "json_private_identity",
    ];
    for (const table of ["person_basic_info", "record_crop_picture_info"] as const) {
      const f = await fixture();
      routers.push(f.router);
      invokeProbe(f.router);
      await sent(f.session);
      expect(request(f.session.sent[0]!).payload.table).toBe(table);
      f.session.table(
        [
          {
            name: secrets[0],
            person_id: secrets[1],
            face_path: secrets[2],
            crop_picture_path: secrets[3],
            face_data: secrets[4],
            people: { [secrets[7]!]: { name: secrets[0], url: secrets[2] } },
            extra: JSON.stringify({ [secrets[8]!]: secrets[4] }),
            ...Object.fromEntries(secrets.map((secret) => [secret, secrets[0]])),
          },
        ],
        { table },
      );
      await tick();
    }
    const text = readFileSync(logFile, "utf8");
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(personLines()).toHaveLength(2);
    for (const [, line] of personLines()) {
      expect(line).toContain("<other>:string[<=64]x10");
      expect(line).toContain("name:string[<=64]x1");
      expect(line).toContain("people:objectx1");
      expect(line).not.toContain("{json}");
    }
  });

  it("logs the real catalog trigger once for reads without rows and once when armed", async () => {
    const f = await fixture();
    router = f.router;
    f.session.accept = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await router.readRecordingCatalog(scope)).toMatchObject({ status: "unavailable", reason: "send_refused" });
      f.advance(61_000);
    }
    expect(
      logLines().filter((line) => line.endsWith("person_probe trigger_skipped reason=no_event_rows")),
    ).toHaveLength(1);
    expect(logLines().filter((line) => line.endsWith("person_probe armed"))).toHaveLength(0);
    expect(outcomes()).toHaveLength(0);
    f.session.accept = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const read = router.readRecordingCatalog(scope);
      await sent(f.session, attempt === 0 ? 3 : 5);
      f.session.table([row()]);
      expect((await read).status).toBe("ok");
      if (attempt === 0) {
        await sent(f.session, 4);
        f.session.table([], { table: "person_basic_info" });
      }
      await tick();
      f.advance(61_000);
    }
    expect(logLines().filter((line) => line.endsWith("person_probe armed"))).toHaveLength(1);
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
    expect(logLines().filter((line) => line.endsWith("person_probe refunded_lines_suppressed after=50"))).toHaveLength(
      1,
    );
    owner.leases--;
    otherOwner.leases--;
    invokeProbe(router);
    await sent(f.session);
    f.session.table([], { table: "person_basic_info" });
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
    f.session.table([{ name: "synthetic-private-value" }], { table: "person_basic_info", mIntRet: 7 });
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
    f.session.table([], { table: "record_crop_picture_info" });
    await tick();
    expect(outcomes()).toEqual([expect.stringMatching(/outcome=empty .*refunded=false attempt=1\/3$/)]);
    expect(logLines().filter((line) => line.endsWith("person_probe eligible"))).toHaveLength(1);
  });

  it("summarizes changed skip and refund counters at most hourly without a background timer", async () => {
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "0");
    const f = await fixture();
    router = f.router;
    vi.useFakeTimers({ toFake: ["Date"] });
    const epoch = Date.now();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now() - epoch + 161_000);
    const summaries = () => logLines().filter((line) => line.includes("person_probe skip_counts "));
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
    expect(request(f.session.sent[1]!).payload.table).toBe("person_basic_info");
    f.session.table([], { table: "person_basic_info" });
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
    expect(request(f.session.sent[3]!).payload.table).toBe("record_crop_picture_info");
    f.session.table([], { table: "record_crop_picture_info" });
    await tick();
    expect(personLines()).toHaveLength(1);
  });

  it("rotates across replacement sessions and shares three attempts per table across routers", async () => {
    vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "1");
    const f = await fixture();
    router = f.router;
    let session = f.session;
    Reflect.get(router, "deps").createSession = () => {
      session = new RecordingSession();
      return session as unknown as RtcSession;
    };
    for (let attempt = 0; attempt < 7; attempt++) {
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
      if (attempt < 6) {
        await sent(session, 2);
        const table = attempt % 2 ? "record_crop_picture_info" : "person_basic_info";
        expect(request(session.sent[1]!).payload.table).toBe(table);
        session.table([], { table });
      }
      await tick();
      expect(session.sent).toHaveLength(attempt < 6 ? 2 : 1);
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
    expect(outcomes()).toHaveLength(6);
    expect(outcomes().map((line) => line.match(/attempt=\d\/3$/)?.[0])).toEqual([
      "attempt=1/3",
      "attempt=1/3",
      "attempt=2/3",
      "attempt=2/3",
      "attempt=3/3",
      "attempt=3/3",
    ]);
    expect(logLines().filter((line) => line.endsWith("person_probe eligible"))).toHaveLength(1);
  });

  it("builds only the nested bounded FULL_TABLE read with the established station envelope", () => {
    const packet = buildEventTableRequest(
      "synthetic-account",
      7,
      "synthetic-transaction",
      100,
      undefined,
      "person_basic_info",
    );
    expect(parsePortalHeader(packet)).toMatchObject({ commandId: 1350, channel: 255, segment: 7, isResponse: 0 });
    expect(request(packet)).toEqual({
      account_id: "synthetic-account",
      cmd: 1306,
      mChannel: 255,
      mValue3: 0,
      payload: {
        cmd: 10000,
        table: "person_basic_info",
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
    expect(probe.payload).toMatchObject({ table: "person_basic_info", cmd: 10000, payload: { count: 100 } });
    f.onFrame.mockClear();
    const reply = {
      cmd: 10000,
      transaction: probe.payload.transaction,
      table: "person_basic_info",
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
          /Z \[rtc\] person_probe table=person_basic_info row keys rows=1 extra:string\[<=64\]x1 name:string\[<=64\]x1 people:objectx1 person_id:string\[<=64\]x1 record_id:numberx1\n$/,
        ),
        { mode: 0o600 },
      ],
    ]);
    expect(outcomes()).toEqual([
      expect.stringMatching(
        /Z \[rtc\] person_probe table=person_basic_info outcome=success elapsedMs=0 rows=1 resultCode=0 compressedBytes=null decompressedBytes=\d+ count=100 ownerContinuous=true generationContinuous=true refunded=false attempt=1\/3$/,
      ),
    ]);
    expect(logLines().every((line) => isoPrefix.test(line))).toBe(true);
    for (const [path, line, options] of vi.mocked(appendFileSync).mock.calls)
      if (String(line).includes("person_probe")) {
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
    f.session.table([], { table: "person_basic_info" });
    await tick();
    expect(personLines().at(-1)?.[1]).toMatch(/Z \[rtc\] person_probe table=person_basic_info row keys rows=0 \n$/);
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
        /table=person_basic_info outcome=busy\/not_admitted refusal=leases elapsedMs=0 rows=null resultCode=null compressedBytes=null decompressedBytes=0 count=100 ownerContinuous=true generationContinuous=true refunded=true attempt=1\/3$/,
      ),
      expect.stringMatching(/table=record_crop_picture_info outcome=busy\/not_admitted .* refunded=true attempt=1\/3$/),
    ]);
    expect(f.session.sent).toHaveLength(0);
    invokeProbe(router);
    await sent(f.session);
    f.session.table([], { table: "person_basic_info" });
    await tick();
    expect(outcomes()).toHaveLength(3);
    expect(outcomes()[2]).toMatch(/outcome=empty .* refunded=false attempt=1\/3$/);
    expect(personLines()).toHaveLength(1);
    const other = await fixture();
    routers.push(other.router);
    invokeProbe(other.router);
    await sent(other.session);
    other.session.table([], { table: "record_crop_picture_info" });
    await tick();
    expect(outcomes()[3]).toMatch(/table=record_crop_picture_info outcome=empty .* attempt=1\/3$/);
    invokeProbe(router);
    invokeProbe(other.router);
    invokeProbe(other.router);
    expect(skipped("session_already_probed")).toHaveLength(1);
    expect(logLines().filter((line) => line.endsWith("person_probe eligible"))).toHaveLength(1);
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
    expect(read).toHaveBeenCalledExactlyOnceWith(
      station,
      { timeoutMs: 2000, queryCount: 100 },
      undefined,
      "person_basic_info",
    );
    expect(outcomes()).toEqual([
      expect.stringMatching(/table=person_basic_info outcome=error errorName=TypeError count=100 attempt=1\/3$/),
    ]);
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
    f.session.table([], { table: "person_basic_info" });
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
            `table=person_basic_info outcome=${ack ? "ack_only/timeout" : "timeout"} elapsedMs=0 rows=null resultCode=null compressedBytes=null decompressedBytes=0 count=100 ownerContinuous=true generationContinuous=true refunded=false attempt=1/3$`,
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
