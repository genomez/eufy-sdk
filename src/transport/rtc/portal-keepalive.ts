/** The portal's unframed 36-byte keepalive, echoed byte-for-byte on the command channel. */
export const PORTAL_KEEPALIVE = Buffer.from(
  "0009000010000000000000006300000000000000585a5948730400000000000000000002",
  "hex",
);

/** The portal's observed interval between raw keepalives. */
export const PORTAL_KEEPALIVE_MS = 29_000;
