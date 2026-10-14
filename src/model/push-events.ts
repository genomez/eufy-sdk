/**
 * eufy push-notification constants.
 *
 * PROVENANCE: the event-type codes are cross-checked against the v6 APK
 * (com.oceanwing.battery.cam) — the AI-detection codes are present in the v6
 * runtime, and v6 uses the same Firebase project (batterycam-3250a / sender
 * 348804314802), so this set is current. v6-only additions noted inline.
 *
 * These are the push-event SEMANTICS the capability layer matches on (motion/doorbell/person/…);
 * {@link detectionName} maps a code to a human label. Pure MCS wire framing is a transport concern
 * and lives with the transport, not here.
 */

/** Generic custom push event (field `a` in CusPushData). */
export enum CusPushEvent {
  SECURITY = 1,
  TFCARD = 2,
  DOOR_SENSOR = 3,
  CAM_STATE = 4,
  GSENSOR = 5,
  BATTERY_LOW = 6,
  BATTERY_HOT = 7,
  LIGHT_STATE = 8,
  MODE_SWITCH = 9,
  ALARM = 10,
  BATTERY_FULL = 11,
  REPEATER_RSSI_WEAK = 12,
  UPGRADE_STATUS = 13,
  MOTION_SENSOR_PIR = 14,
  ALARM_DELAY = 16,
  HUB_BATT_POWERED = 17,
  SENSOR_NO_OPEN = 18,
  SMART_DROP = 20,
}

/** Alarm trigger source. */
export enum CusPushAlarmType {
  HUB_STOP = 0,
  DEV_STOP = 1,
  GSENSOR = 2,
  PIR = 3,
  APP = 4,
  HOT = 5,
  DOOR = 6,
  CAMERA = 7,
  MOTION_SENSOR = 8,
  CAMERA_GSENSOR = 9,
  CAMERA_APP = 10,
  CAMERA_LINKAGE = 11,
  HUB_LINKAGE = 12,
  HUB_KEYPAD_PANIC_BUTTON = 13,
  HUB_KEYPAD_EMERGENCY_CODE = 14,
  HUB_STOP_BY_KEYPAD = 15,
  HUB_STOP_BY_APP = 16,
  HUB_STOP_BY_HUB = 17,
  HUB_KEYPAD_CUSTOM_NOT_MAP = 18,
}

/** Arming/mode-switch source. */
export enum CusPushMode {
  SWITCH_FROM_KEYPAD = 1,
  SWITCH_FROM_APP = 2,
  SWITCH = 9,
}

/** Doorbell AI-detection events (3xxx). All v6-confirmed. */
export enum DoorbellPushEvent {
  BACKGROUND_ACTIVE = 3100,
  MOTION_DETECTION = 3101,
  FACE_DETECTION = 3102,
  PRESS_DOORBELL = 3103,
  PET_DETECTION = 3106,
  VEHICLE_DETECTION = 3107,
  PACKAGE_DELIVERED = 3301,
  PACKAGE_TAKEN = 3302,
  FAMILY_DETECTION = 3303,
  PACKAGE_STRANDED = 3304,
  SOMEONE_LOITERING = 3305,
  RADAR_MOTION_DETECTION = 3306,
  AWAY_FROM_HOME = 3307,
  RADAR_DETECTION = 3308,
}

/** Indoor-camera AI-detection events. */
export enum IndoorPushEvent {
  MOTION_DETECTION = 3101,
  FACE_DETECTION = 3102,
  CRYING_DETECTION = 3104,
  SOUND_DETECTION = 3105,
  PET_DETECTION = 3106,
  VEHICLE_DETECTION = 3107,
}

/** HomeBase-3 paired-device AI-detection events (3108-3112 are v6-era). */
export enum HB3PairedDevicePushEvent {
  MOTION_DETECTION = 3101,
  FACE_DETECTION = 3102,
  PRESS_DOORBELL = 3103,
  CRYING_DETECTION = 3104,
  SOUND_DETECTION = 3105,
  PET_DETECTION = 3106,
  VEHICLE_DETECTION = 3107,
  DOG_DETECTION = 3108,
  DOG_LICK_DETECTION = 3109,
  DOG_POOP_DETECTION = 3110,
  IDENTITY_PERSON_DETECTION = 3111,
  STRANGER_PERSON_DETECTION = 3112,
}

/** Lock action / status events. */
export enum LockPushEvent {
  MANUAL_UNLOCK = 257,
  AUTO_UNLOCK = 258,
  PW_UNLOCK = 259,
  FINGERPRINT_UNLOCK = 260,
  APP_UNLOCK = 261,
  MANUAL_LOCK = 262,
  KEYPAD_LOCK = 263,
  APP_LOCK = 264,
  AUTO_LOCK = 265,
  PW_LOCK = 266,
  FINGER_LOCK = 267,
  TEMPORARY_PW_LOCK = 268,
  TEMPORARY_PW_UNLOCK = 269,
  LOW_POWER = 513,
  VERY_LOW_POWER = 514,
  MULTIPLE_ERRORS = 515,
  LOCK_OFFLINE = 516,
  MECHANICAL_ANOMALY = 517,
  VIOLENT_DESTRUCTION = 518,
  LOCK_MECHANICAL_ANOMALY = 519,
  DOOR_OPEN_LEFT = 520,
  DOOR_TAMPER = 521,
  DOOR_STATE_ERROR = 522,
  STATUS_CHANGE = 769,
  OTA_STATUS = 770,
  LOCK_ONLINE = 771,
}

/** SmartDrop locker events. */
export enum SmartDropPushEvent {
  LOW_BATTERY = 6,
  OVERHEATING_WARNING = 7,
  TAMPERED_WARNING = 10,
  BATTERY_FULLY_CHARGED = 11,
  PERSON_DETECTED = 3102,
}

/** Push notification presentation style. */
export enum NotificationStyle {
  TEXT = 1,
  THUMB = 2,
  ALL = 3,
}

/** Resolve a 3xxx AI-detection event id to a human name (camera/doorbell). */
export function detectionName(eventType: number): string {
  return (
    HB3PairedDevicePushEvent[eventType] ??
    DoorbellPushEvent[eventType] ??
    IndoorPushEvent[eventType] ??
    `EVENT_${eventType}`
  );
}
