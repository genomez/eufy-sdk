import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { buildSync } from "esbuild";
import { FileSessionStore } from "../store.js";

/** Independent stores share a path without sharing temporary files. */
describe.each([
  ["FileSessionStore", "../store.ts"],
  ["FileFcmStore", "../../transport/push/store.ts"],
])("concurrent %s writers", (name, entry) => {
  it("keeps a complete final record under simultaneous saves and leaves no temp files", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "store-concurrent-spec-")), "shared.json");
    new FileSessionStore<unknown>(path).save({ writer: -1, sequence: 0, padding: "x".repeat(64 * 1024) });
    const code = buildSync({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      platform: "node",
      format: "cjs",
      bundle: true,
      write: false,
    }).outputFiles[0]!.text;
    const gate = new SharedArrayBuffer(8);
    const workers: Worker[] = [];
    const ready: Promise<unknown>[] = [];
    const completed: Promise<void>[] = [];
    for (let writer = 0; writer < 3; writer++) {
      const worker = new Worker(
        code +
          `
          const { parentPort, workerData } = require("node:worker_threads");
          const store = new module.exports[workerData.name](workerData.path);
          parentPort.postMessage("ready");
          Atomics.wait(new Int32Array(workerData.gate), 1, 0);
          for (let sequence = 0; sequence < 50; sequence++) {
            store.save({ writer: workerData.writer, sequence, padding: "x".repeat(64 * 1024) });
          }
        `,
        { eval: true, workerData: { name, path, writer, gate } },
      );
      workers.push(worker);
      ready.push(
        new Promise((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
        }),
      );
      completed.push(
        new Promise((resolve, reject) => {
          worker.once("error", reject);
          worker.once("exit", (status) => (status === 0 ? resolve() : reject(new Error(`writer exit ${status}`))));
        }),
      );
    }
    const readFailures: unknown[] = [];
    let reads = 0;
    let reader: ReturnType<typeof setInterval> | undefined;
    try {
      await Promise.all(ready);
      if (process.platform !== "win32")
        reader = setInterval(() => {
          try {
            const record = JSON.parse(readFileSync(path, "utf8"));
            expect(record.padding).toBe("x".repeat(64 * 1024));
            expect(record.writer).toBeGreaterThanOrEqual(-1);
            expect(record.writer).toBeLessThan(3);
            reads++;
          } catch (error) {
            readFailures.push(error);
          }
        }, 1);
      Atomics.store(new Int32Array(gate), 1, 1);
      Atomics.notify(new Int32Array(gate), 1);
      await Promise.all(completed);
      expect(readFailures).toEqual([]);
      if (process.platform !== "win32") expect(reads).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(path, "utf8")).sequence).toBe(49);
      expect(readdirSync(join(path, ".."))).toEqual(["shared.json"]);
    } finally {
      clearInterval(reader);
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  });
});
