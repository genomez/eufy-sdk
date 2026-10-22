import { describe, expect, it } from "vitest";
import { CommandHealthGate } from "../command-health.js";

const refusal = {
  status: "rejected",
  sendAttempted: true,
  effect: "unconfirmed",
  rejectionCode: -108,
  responseLatencyMs: 1_000,
} as const;

describe("bounded property command health evidence", () => {
  it("preserves admitted refusal lineage when a new explicit token is denied at pending capacity", () => {
    const gate = new CommandHealthGate(() => undefined);
    try {
      const first = gate.bind("target", "property", 1, false)!;
      first.sent = true;
      gate.response(first, refusal);
      const pending = Array.from({ length: 1_023 }, (_, i) => gate.bind("target", "property", i + 2, true)!);
      expect(pending.every(Boolean)).toBe(true);
      expect(gate.bind("target", "property", 1_025, false)).toBeUndefined();
      pending[0]!.sent = true;
      gate.response(pending[0], refusal);
      expect(gate.status("target", "property").status).toBe("command_degraded");
      expect(pending.slice(1).every((token) => token.controller.signal.aborted)).toBe(true);
      expect(gate.diagnostics()).toMatchObject({ activations: 1, suppressedSends: 1_022 });
    } finally {
      gate.close();
    }
  });

  it("orders receipt, event and passive snapshot health with monotonically increasing revisions", () => {
    let now = 0;
    const events: any[] = [];
    const gate = new CommandHealthGate(
      (event) => events.push(event),
      () => now,
    );
    try {
      const initial = gate.status("target", "property");
      expect(initial).toMatchObject({ revision: 0 });
      const parent = gate.bind("target", "property", 1, false)!;
      parent.sent = true;
      gate.response(parent, refusal);
      const child = gate.child(parent)!;
      child.sent = true;
      gate.response(child, refusal);
      const degraded = gate.status("target", "property") as any;
      expect(degraded.revision).toBeGreaterThan((initial as any).revision);
      expect(events.at(-1)).toMatchObject(degraded);
      now = 600_000;
      const recovered = gate.status("target", "property") as any;
      expect(recovered.revision).toBeGreaterThan(degraded.revision);
      expect(events.at(-1)).toMatchObject(recovered);
    } finally {
      gate.close();
    }
  });
  it("counts distinct sends at inclusive timing boundaries and ignores duplicate responses", () => {
    let now = 0;
    const gate = new CommandHealthGate(
      () => undefined,
      () => now,
    );
    try {
      const original = gate.bind("target", "property-a", 1, false)!;
      gate.response(original, refusal);
      gate.response(original, refusal);
      expect(gate.status("target", "property-a").status).toBe("healthy");
      now = 60_000;
      const child = gate.child(original)!;
      child.sent = true;
      gate.response(child, refusal);
      expect(gate.status("target", "property-a")).toEqual({
        status: "command_degraded",
        cooldownRemainingMs: 600_000,
        revision: 1,
      });
      expect(gate.status("target", "property-b").status).toBe("healthy");
      expect(gate.diagnostics()).toMatchObject({ activations: 1, fastRefusals: 2 });
    } finally {
      gate.close();
    }
  });

  it("does not combine a superseded response with a newer explicit lineage", () => {
    const gate = new CommandHealthGate(() => undefined);
    try {
      const old = gate.bind("target", "property", 1, false)!;
      const latest = gate.bind("target", "property", 2, false)!;
      gate.response(old, refusal);
      gate.response(latest, refusal);
      expect(gate.status("target", "property").status).toBe("healthy");
      expect(gate.child(old)).toBeUndefined();
    } finally {
      gate.close();
    }
  });

  it("bounds retained targets without evicting active cooldowns and reclaims expired evidence", () => {
    let now = 0;
    const gate = new CommandHealthGate(
      () => undefined,
      () => now,
    );
    try {
      const first = gate.bind("target-0", "property", 1, false)!;
      first.sent = true;
      gate.response(first, refusal);
      const child = gate.child(first)!;
      child.sent = true;
      gate.response(child, refusal);
      gate.release(first);
      gate.release(child);
      for (let i = 1; i < 1_024; i++) {
        const token = gate.bind(`target-${i}`, "property", i + 1, false)!;
        gate.release(token);
      }
      expect(gate.bind("overflow", "property", 1_025, false)).toBeUndefined();
      expect(gate.status("target-0", "property").status).toBe("command_degraded");
      expect(gate.diagnostics()).toMatchObject({ capacity: 1_024, entries: 1_024, activeDegraded: 1 });
      now = 600_001;
      const next = gate.bind("overflow", "property", 1_026, false)!;
      expect(next).toBeDefined();
      expect(gate.diagnostics()).toMatchObject({ entries: 1, activeDegraded: 0, cooldownExpiries: 1 });
    } finally {
      gate.close();
    }
  });
});
