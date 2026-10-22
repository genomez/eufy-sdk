/** Accepted, validated invocation ownership; replacement applies only to the declared property key. */
export interface CommandIntent {
  readonly station: string;
  readonly device: string;
  readonly ordinal: number;
  readonly targetGeneration: number;
  readonly replacementKey?: string;
  readonly propertyGeneration?: number;
  readonly replaceUnsent?: boolean;
}

/** One bounded registry owns preparation ordering, property replacement and target recovery authority. */
export class CommandIntentRegistry {
  private ordinal = 0;
  private generation = 0;
  private floor = 0;
  private readonly stationFloors = new Map<string, number>();
  private readonly targets = new Map<string, CommandIntent>();
  private readonly properties = new Map<string, CommandIntent>();
  private readonly replacements = new Map<string, CommandIntent>();
  private readonly listeners = new Set<
    (previous: CommandIntent | undefined, current: CommandIntent | undefined) => void
  >();

  constructor(private readonly capacity = 1024) {}

  /** Allocate before asynchronous preparation; only successfully validated commands may be accepted. */
  allocate(): number {
    if (this.ordinal >= Number.MAX_SAFE_INTEGER) throw new Error("intent ordinal exhausted");
    return ++this.ordinal;
  }

  /** Property replacement and target recovery retain independent invocation ordering. */
  acceptValidated(
    station: string,
    device: string,
    ordinal: number,
    replacementKey?: string,
    replaceUnsent = true,
  ): CommandIntent | undefined {
    if (
      !Number.isSafeInteger(ordinal) ||
      ordinal <= Math.max(this.floor, this.stationFloors.get(station) ?? 0) ||
      ordinal > this.ordinal
    )
      return undefined;
    const key = this.targetKey(station, device);
    const previous = this.targets.get(key);
    if (previous && ordinal === previous.ordinal) return undefined;
    if (!previous && this.targets.size >= this.capacity) return undefined;
    const propertyKey = replacementKey === undefined ? undefined : JSON.stringify([station, device, replacementKey]);
    const property = propertyKey ? this.properties.get(propertyKey) : undefined;
    const replacement = propertyKey ? this.replacements.get(propertyKey) : undefined;
    if (propertyKey && ordinal <= ((replaceUnsent ? property : replacement)?.ordinal ?? 0)) return undefined;
    if (propertyKey && !this.properties.has(propertyKey) && this.properties.size >= this.capacity) return undefined;
    const intent: CommandIntent = Object.freeze({
      station,
      device,
      ordinal,
      targetGeneration: ++this.generation,
      ...(replacementKey === undefined ? {} : { replacementKey, propertyGeneration: this.generation, replaceUnsent }),
    });
    if (propertyKey) {
      if (!property || ordinal > property.ordinal) this.properties.set(propertyKey, intent);
      if (replaceUnsent) this.replacements.set(propertyKey, intent);
    }
    if (!previous || ordinal > previous.ordinal) {
      this.targets.set(key, intent);
      for (const listener of this.listeners) listener(previous, intent);
    }
    return intent;
  }

  /** Any newer control on the target retires recovery, including a different property or action. */
  isCurrent(intent: CommandIntent): boolean {
    return this.targets.get(this.targetKey(intent.station, intent.device)) === intent;
  }

  /** Only a newer explicit declaration for the same property replaces an unsent property write. */
  isPropertyCurrent(intent: CommandIntent): boolean {
    if (intent.ordinal <= Math.max(this.floor, this.stationFloors.get(intent.station) ?? 0)) return false;
    if (intent.replacementKey === undefined) return true;
    const key = JSON.stringify([intent.station, intent.device, intent.replacementKey]);
    return intent.replaceUnsent === false
      ? (this.replacements.get(key)?.ordinal ?? 0) < intent.ordinal
      : this.properties.get(key) === intent;
  }

  subscribe(listener: (previous: CommandIntent | undefined, current: CommandIntent | undefined) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  invalidateStation(station: string): void {
    if (!this.stationFloors.has(station) && this.stationFloors.size >= this.capacity) {
      this.close();
      return;
    }
    this.stationFloors.set(station, this.ordinal);
    for (const [key, intent] of this.targets) {
      if (intent.station !== station) continue;
      this.targets.delete(key);
      for (const listener of this.listeners) listener(intent, undefined);
    }
    for (const [key, intent] of this.properties) if (intent.station === station) this.properties.delete(key);
    for (const [key, intent] of this.replacements) if (intent.station === station) this.replacements.delete(key);
  }

  close(): void {
    this.floor = this.ordinal;
    for (const intent of this.targets.values()) for (const listener of this.listeners) listener(intent, undefined);
    this.targets.clear();
    this.properties.clear();
    this.replacements.clear();
    this.stationFloors.clear();
  }

  private targetKey(station: string, device: string): string {
    return JSON.stringify([station, device]);
  }
}
