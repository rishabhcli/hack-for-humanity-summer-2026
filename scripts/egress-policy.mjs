/**
 * The frame-egress policy.
 *
 * Domain invariant I6 — "raw frames are not transmitted or retained by default" — is usually
 * asserted, and occasionally tested by watching the network tab. Neither is an encoding: a promise
 * about runtime behaviour cannot be checked by a compiler, and a network capture only proves what
 * did not happen on the paths the capture exercised.
 *
 * This policy encodes it structurally instead, by removing the capability from the bundle:
 *
 * 1. **No shipped source may reference a network API.** With no `fetch`, no `XMLHttpRequest`, no
 *    `WebSocket` and no `sendBeacon` anywhere in `src/`, there is no code path that can send
 *    anything anywhere — on the happy path or on an error path.
 * 2. **No shipped source may reference a frame-serialization API.** With no `toDataURL`, no
 *    `toBlob`, no `MediaRecorder` and no `captureStream`, a video frame cannot be turned into
 *    bytes in the first place.
 *
 * Together those make frame egress unreachable rather than merely unintended, including in code a
 * future contributor adds outside the camera path.
 */

/**
 * @typedef EgressRule
 * @property {string} code
 * @property {readonly string[]} names identifiers or member names that must not appear
 * @property {string} rationale
 */

/** @type {readonly EgressRule[]} */
export const PROHIBITED_EGRESS_APIS = [
  {
    code: 'EGRESS_NETWORK_API',
    names: [
      'EventSource',
      'RTCDataChannel',
      'RTCPeerConnection',
      'WebSocket',
      'WebTransport',
      'XMLHttpRequest',
      'fetch',
      'importScripts',
      'sendBeacon',
    ],
    rationale:
      'this tool performs no network input or output at runtime, so referencing a transport API at all would create a path frames could leave by',
  },
  {
    code: 'EGRESS_FRAME_SERIALIZATION_API',
    names: [
      'MediaRecorder',
      'captureStream',
      'convertToBlob',
      'getImageData',
      'toBlob',
      'toDataURL',
    ],
    rationale:
      'a frame that cannot be turned into bytes cannot be transmitted or retained, whatever else the code does',
  },
];

/**
 * References permitted despite matching a prohibited name.
 *
 * Each entry is an exact `file:name` pair, so an exemption is per-site and visible in review rather
 * than a blanket hole. There are currently none: the shipped bundle references no prohibited API.
 *
 * @type {readonly string[]}
 */
export const EGRESS_EXEMPTIONS = [];

/**
 * Decides whether one referenced name at one location violates the policy.
 *
 * @param {string} file repository-relative path
 * @param {string} name identifier or member name
 * @returns {{code: string, rationale: string} | null}
 */
export function egressViolation(file, name) {
  if (EGRESS_EXEMPTIONS.includes(`${file}:${name}`)) {
    return null;
  }
  for (const rule of PROHIBITED_EGRESS_APIS) {
    if (rule.names.includes(name)) {
      return { code: rule.code, rationale: rule.rationale };
    }
  }
  return null;
}

/** Total number of names the policy prohibits, for the passing summary line. */
export function prohibitedApiCount() {
  return PROHIBITED_EGRESS_APIS.reduce((total, rule) => total + rule.names.length, 0);
}
