// Facade surface: the EufyMega client, its options/event types, and the
// freshestLanIp helper. The class + its declaration-merged event interface
// live together in eufy-mega.ts (declaration merging requires one module).
export * from "./eufy-mega.js";
export type {
  RecordingPolicy,
  RecordingReadScope,
  RecordingReadOptions,
  RecordingPacing,
  RecordingReadReason,
  RecordingReadFailure,
  RecordingTimeStatus,
  RecordingKind,
  InternalRecordingRow,
  InternalCoverSelector,
  CatalogReadResult,
  CoverReadResult,
  RecordingDiagnostics,
  RecordingRowView,
} from "../transport/rtc/recordings.js";
export { projectRecordingRow } from "../transport/rtc/recordings.js";
