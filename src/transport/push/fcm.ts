/**
 * FCM registration — obtain an FCM token the eufy cloud can push to.
 *
 * Flow: generate a Firebase Installation ID (FID) → register it with Firebase
 * installations → GServices check-in (→ androidId + securityToken) → GCM
 * register3 (→ FCM token). The androidId/securityToken/token are persisted so we
 * register once and just reconnect afterwards.
 *
 * The Firebase project constants below were read from the v6 APK
 * (com.oceanwing.battery.cam): project batterycam-3250a, sender 348804314802 —
 * identical to the legacy app, so registering here receives v6 account pushes.
 */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { checkinRoot } from "./proto.js";
import type { FcmCredentials } from "./types.js";
import { noopLogger, type Logger } from "../../core/logger.js";

export const FCM = {
  PROJECT_ID: "batterycam-3250a",
  API_KEY: "AIzaSyCSz1uxGrHXsEktm7O3_wv-uLGpC9BvXR8",
  APP_ID: "1:348804314802:android:440a6773b3620da7",
  SENDER_ID: "348804314802",
  PACKAGE: "com.oceanwing.battery.cam",
  CERT_SHA1: "F051262F9F99B638F3C76DE349830638555B4A0A",
  AUTH_VERSION: "FIS_v2",
  SDK_VERSION: "a:16.3.1",
} as const;

/** Generate a valid Firebase Installation ID (22 url-safe chars, starts c-f). */
export function generateFid(): string {
  const b = randomBytes(17);
  b[0] = 0b01110000 + (b[0] % 0b00010000); // 4-bit FID header
  return b.toString("base64url").slice(0, 22);
}

interface FidInstallation {
  refreshToken: string;
  authToken: { token: string };
}

export class FcmRegistrar {
  constructor(private readonly logger: Logger = noopLogger) {}

  /** Full registration → FcmCredentials. */
  async register(): Promise<FcmCredentials> {
    const fid = generateFid();
    const install = await this.installFid(fid);
    const { androidId, securityToken } = await this.checkin();
    const fcmToken = await this.gcmRegister(fid, androidId, securityToken, install.authToken.token);
    this.logger.debug("[fcm] registered token", fcmToken.slice(0, 24) + "…");
    return { fid, androidId, securityToken, fcmToken, refreshToken: install.refreshToken, createdAt: Date.now() };
  }

  private async installFid(fid: string): Promise<FidInstallation> {
    const url = `https://firebaseinstallations.googleapis.com/v1/projects/${FCM.PROJECT_ID}/installations`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Android-Package": FCM.PACKAGE,
        "X-Android-Cert": FCM.CERT_SHA1,
        "x-goog-api-key": FCM.API_KEY,
      },
      body: JSON.stringify({ fid, appId: FCM.APP_ID, authVersion: FCM.AUTH_VERSION, sdkVersion: FCM.SDK_VERSION }),
    });
    if (res.status !== 200) throw new Error(`FID install failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as FidInstallation;
  }

  private async checkin(): Promise<{ androidId: string; securityToken: string }> {
    const CheckinRequest = checkinRoot().lookupType("CheckinRequest");
    const CheckinResponse = checkinRoot().lookupType("CheckinResponse");
    const payload = {
      androidId: 0,
      checkin: {
        build: {
          fingerprint: "google/razor/flo:5.0.1/LRX22C/1602158:user/release-keys",
          hardware: "flo",
          brand: "google",
          radio: "FLO-04.04",
          clientId: "android-google",
        },
        lastCheckinMs: 0,
      },
      locale: "en",
      loggingId: 1234567890,
      timeZone: "GMT",
      version: 3,
      fragment: 0,
      userSerialNumber: 0,
    };
    const body = CheckinRequest.encode(CheckinRequest.create(payload)).finish();
    const res = await fetch("https://android.clients.google.com/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/x-protobuf" },
      body,
    });
    if (res.status !== 200) throw new Error(`checkin failed (${res.status})`);
    const obj = CheckinResponse.toObject(CheckinResponse.decode(new Uint8Array(await res.arrayBuffer())), {
      longs: String,
    });
    if (!obj.androidId || !obj.securityToken) throw new Error("checkin returned no androidId/securityToken");
    return { androidId: String(obj.androidId), securityToken: String(obj.securityToken) };
  }

  private async gcmRegister(
    fid: string,
    androidId: string,
    securityToken: string,
    fidAuthToken: string,
  ): Promise<string> {
    const params = new URLSearchParams({
      "X-subtype": FCM.SENDER_ID,
      sender: FCM.SENDER_ID,
      "X-app_ver": "741",
      "X-osv": "25",
      "X-cliv": "fiid-20.2.0",
      "X-gmsv": "201216023",
      "X-appid": fid,
      "X-scope": "*",
      "X-Goog-Firebase-Installations-Auth": fidAuthToken,
      "X-gmp_app_id": FCM.APP_ID,
      "X-firebase-app-name-hash": "R1dAH9Ui7M-ynoznwBdw01tLxhI",
      "X-Firebase-Client-Log-Type": "1",
      app: FCM.PACKAGE,
      device: androidId,
      app_ver: "741",
      gcm_ver: "201216023",
      plat: "0",
      cert: FCM.CERT_SHA1,
      target_ver: "28",
    });
    // The gateway is occasionally flaky; retry a few times.
    let last = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch("https://android.clients.google.com/c2dm/register3", {
        method: "POST",
        headers: {
          Authorization: `AidLogin ${androidId}:${securityToken}`,
          app: FCM.PACKAGE,
          gcm_ver: "201216023",
          "User-Agent": "Android-GCM/1.5",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });
      last = await res.text();
      const m = last.match(/token=(.+)/);
      if (m) return m[1].trim();
      this.logger.debug(`[fcm] register3 attempt ${attempt + 1}:`, last.slice(0, 120));
      await sleep(1000 * (attempt + 1));
    }
    throw new Error(`GCM register failed: ${last.slice(0, 200)}`);
  }
}
