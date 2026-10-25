/**
 * MCS wire-stream parser. The TLS stream is framed as:
 *   first packet:  [version:1][tag:1][varint length][protobuf]
 *   then each msg: [tag:1][varint length][protobuf]
 * Chunks arrive arbitrarily split, so we accumulate and re-enter as data lands.
 * Implements Google's MCS (mtalk) stream framing.
 */
import { EventEmitter } from "node:events";
import type { Reader, Type } from "protobufjs";
import { protobufjs } from "../protobuf.js";
import { mcsRoot } from "./proto.js";
import { MessageTag } from "./message-tags.js";
import type { McsMessage } from "./types.js";

enum State {
  VERSION_TAG_AND_SIZE = 0,
  TAG_AND_SIZE = 1,
  SIZE = 2,
  PROTO_BYTES = 3,
}

const TAG_TO_TYPE: Partial<Record<MessageTag, string>> = {
  [MessageTag.HeartbeatPing]: "mcs_proto.HeartbeatPing",
  [MessageTag.HeartbeatAck]: "mcs_proto.HeartbeatAck",
  [MessageTag.LoginRequest]: "mcs_proto.LoginRequest",
  [MessageTag.LoginResponse]: "mcs_proto.LoginResponse",
  [MessageTag.Close]: "mcs_proto.Close",
  [MessageTag.IqStanza]: "mcs_proto.IqStanza",
  [MessageTag.DataMessageStanza]: "mcs_proto.DataMessageStanza",
  [MessageTag.StreamErrorStanza]: "mcs_proto.StreamErrorStanza",
};

export class McsParser extends EventEmitter {
  private data = Buffer.alloc(0);
  private state = State.VERSION_TAG_AND_SIZE;
  private messageTag = 0;
  private messageSize = 0;
  private sizePacketSoFar = 0;

  /** Reset for a fresh connection. */
  reset(): void {
    this.data = Buffer.alloc(0);
    this.state = State.VERSION_TAG_AND_SIZE;
    this.messageTag = 0;
    this.messageSize = 0;
    this.sizePacketSoFar = 0;
  }

  /**
   * Feed TLS bytes; only framing/decoding failures reach onFrameError, never message listener errors.
   * Without a handler, parsing failures throw. A handled failure ends the feed and requires reset before reuse.
   */
  handleData(chunk: Buffer, onFrameError?: () => void): void {
    let pending: Buffer | undefined = chunk;
    while (true) {
      let message: McsMessage | undefined;
      let failed = false;
      try {
        if (pending) {
          this.data = Buffer.concat([this.data, pending]);
          pending = undefined;
        }
        message = this.readMessage();
      } catch (error) {
        if (!onFrameError) throw error;
        failed = true;
      }
      if (failed) {
        onFrameError!();
        return;
      }
      if (!message) return;
      this.emitMessage(message);
    }
  }

  private minBytesNeeded(): number {
    switch (this.state) {
      case State.VERSION_TAG_AND_SIZE:
        return 1 + 1 + 1;
      case State.TAG_AND_SIZE:
        return 1 + 1;
      case State.SIZE:
        return this.sizePacketSoFar + 1;
      case State.PROTO_BYTES:
        return this.messageSize;
    }
  }

  /** Advance wire state until one decoded message or an incomplete frame, without dispatching listeners. */
  private readMessage(): McsMessage | undefined {
    while (this.data.length >= this.minBytesNeeded()) {
      switch (this.state) {
        case State.VERSION_TAG_AND_SIZE:
          this.onVersion();
          break;
        case State.TAG_AND_SIZE:
          this.onTag();
          break;
        case State.SIZE:
          this.onSize();
          break;
        case State.PROTO_BYTES: {
          const message = this.onBytes();
          this.state = State.TAG_AND_SIZE;
          return message;
        }
      }
    }
  }

  private onVersion(): void {
    const version = this.data.readInt8(0);
    this.data = this.data.subarray(1);
    if (version < 38) throw new Error(`MCS: wrong protocol version ${version}`);
    this.state = State.TAG_AND_SIZE;
  }

  private onTag(): void {
    this.messageTag = this.data.readInt8(0);
    this.data = this.data.subarray(1);
    this.state = State.SIZE;
  }

  private onSize(): void {
    const reader: Reader = protobufjs().Reader.create(this.data);
    let incomplete = false;
    try {
      this.messageSize = reader.int32();
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("index out of range:")) incomplete = true;
      else throw e;
    }
    if (incomplete) {
      this.sizePacketSoFar = reader.pos;
      this.state = State.SIZE;
      return;
    }
    this.data = this.data.subarray(reader.pos);
    this.sizePacketSoFar = 0;
    if (this.messageSize < 0) throw new Error("MCS: negative frame length");
    this.state = State.PROTO_BYTES;
  }

  private onBytes(): McsMessage {
    if (this.messageSize === 0) {
      return { tag: this.messageTag, object: {} };
    }
    const buf = this.data.subarray(0, this.messageSize);
    this.data = this.data.subarray(this.messageSize);
    const typeName = TAG_TO_TYPE[this.messageTag as MessageTag];
    let object: any = {};
    if (typeName) {
      const type: Type = mcsRoot().lookupType(typeName);
      object = type.toObject(type.decode(buf), { longs: String, enums: String, bytes: Buffer });
    }
    return { tag: this.messageTag, object };
  }

  private emitMessage(m: McsMessage): void {
    this.emit("message", m);
  }
}
