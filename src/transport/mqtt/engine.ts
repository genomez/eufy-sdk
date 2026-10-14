/**
 * The MQTT engine, loaded on first use rather than at import.
 *
 * `mqtt` costs **+19 MB of RSS** to import — measured one fresh process per module, because a single
 * process importing several in sequence gives meaningless per-module deltas — which is a large share of
 * what importing this package costs at all (+36 MB over a bare node; +24 after this). Every consumer
 * paid it at module load, including the ones whose accounts have no appliance to talk MQTT to: the
 * secure broker is only reached when a device needs it, and a camera-only account never opens one.
 *
 * So the import moves to the two places that actually dial a broker. Both already return promises, so
 * nothing about their contracts changes — an `await` in front of a network connect is not a cost.
 */
type Mqtt = typeof import("mqtt");
let enginePromise: Promise<Mqtt> | undefined;

/** Memoized lazy import of the MQTT engine — the ONLY runtime reference to `mqtt` in this package. */
export function loadMqtt(): Promise<Mqtt> {
  return (enginePromise ??= import("mqtt").then((m) => m.default ?? m));
}
