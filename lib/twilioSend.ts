import twilio from "twilio";
import { toE164 } from "./phone";
import { assertNotGloballyBlocked, BlockedNumberError } from "./globalBlocklist";

export { BlockedNumberError };

// Single choke point for every outbound Twilio WhatsApp send in the app.
//
// Why this exists: send-reply, send-sms, and send-sms/twilio each used
// to build their own Twilio payload inline.
// Every one of them sent via `messagingServiceSid` alone, with no `from`.
// Twilio's Messaging Service is then free to pick ANY number in its sender
// pool to actually deliver the message — and since multiple users' numbers
// live in the same shared Messaging Service, that meant a message sent by
// user A could go out from user B's number. When the customer replied, the
// inbound webhook (correctly) attributed it to whoever owns the number the
// reply landed on — user B — not the user who actually started the
// conversation. That's the cross-account leak.
//
// The fix is to always pin `from` to the sending user's own dedicated
// WhatsApp-enabled number. Routing every send through this one function
// means that guarantee can't be silently dropped by a new call site in
// the future.
//
// SMS -> WhatsApp: every `to`/`from` Twilio actually sends with here is
// given the mandatory "whatsapp:" channel prefix internally, so every call
// site below keeps passing plain E.164 numbers exactly as it did for SMS.
// The one behavior difference callers need to know about: WhatsApp only
// allows a free-form `body` send when the customer messaged this number
// within the last 24 hours (the "customer service window"). Outside that
// window — which covers every first-touch/bulk marketing send — Meta
// requires a pre-approved message Template, sent via `contentSid` +
// `contentVariables` instead of `body`. Pass `contentSid`/`contentVariables`
// for template sends (see app/api/send-sms/twilio/route.ts); leave them
// unset and pass `body` for in-window replies.

export type SendSmsUserData = {
  twilioNumber?: string;
  assignedTwilioNumber?: string;
  messagingServiceSid?: string;
};

export type SendSmsResult = {
  sid: string;
  status: string;
  from: string;
};

export class MissingTwilioNumberError extends Error {
  constructor() {
    super("No WhatsApp-enabled Twilio number is assigned to this user.");
    this.name = "MissingTwilioNumberError";
  }
}

export class MissingTwilioConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingTwilioConfigError";
  }
}

export class MissingWhatsAppTemplateError extends Error {
  constructor() {
    super(
      "This is a first-touch WhatsApp message, which requires an approved message template (contentSid) — a plain text body can only be sent as a reply within 24 hours of the customer's last message."
    );
    this.name = "MissingWhatsAppTemplateError";
  }
}

function resolveTwilioNumber(userData: SendSmsUserData) {
  return toE164(String(userData.twilioNumber || userData.assignedTwilioNumber || ""));
}

export function getUserTwilioNumber(userData: SendSmsUserData) {
  return resolveTwilioNumber(userData);
}

// Twilio's WhatsApp channel requires every `to`/`from` to carry this
// literal prefix ahead of the E.164 number - this is the one place that
// prefix gets added, so nothing stored in Firestore ever has to carry it.
function toWhatsAppAddress(e164: string) {
  const normalized = toE164(e164);
  return normalized ? `whatsapp:${normalized}` : "";
}

function stripWhatsAppPrefix(address: string) {
  return String(address || "").replace(/^whatsapp:/i, "");
}

export async function sendSmsForUser(opts: {
  userData: SendSmsUserData;
  to: string;
  body?: string;
  mediaUrls?: string[];
  statusCallbackPath?: string;
  // Approved WhatsApp message Template SID (Twilio Content API,
  // "HX..."), required for any business-initiated send outside the
  // 24-hour customer service window. Takes precedence over `body` when
  // both are provided — Twilio rejects a send that mixes the two.
  contentSid?: string;
  // Named variables the template's placeholders ({{1}}, {{2}}, ...) fill
  // in with, e.g. { "1": "Hi Sara" }.
  contentVariables?: Record<string, string>;
}): Promise<SendSmsResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const appBaseUrl = process.env.APP_BASE_URL?.trim()?.replace(/\/$/, "");

  if (!accountSid || !authToken) {
    throw new MissingTwilioConfigError("Missing Twilio account configuration.");
  }

  const twilioNumber = resolveTwilioNumber(opts.userData);
  if (!twilioNumber) {
    throw new MissingTwilioNumberError();
  }

  const messagingServiceSid = String(
    opts.userData.messagingServiceSid || process.env.TWILIO_MESSAGING_SERVICE_SID || ""
  ).trim();

  const to = toE164(opts.to);
  const body = String(opts.body || "").trim();
  const mediaUrl = (opts.mediaUrls || []).filter(Boolean);
  const contentSid = String(opts.contentSid || "").trim();

  if (!contentSid && !body) {
    throw new MissingWhatsAppTemplateError();
  }

  // Platform-wide opt-out check. This runs regardless of whether the
  // calling route did its own per-owner blacklist check (one of them,
  // send-sms/twilio/route.ts, never did) — so this is the one place a
  // STOP can never be bypassed by any current or future send path.
  await assertNotGloballyBlocked(to);

  const client = twilio(accountSid, authToken);

  const payload: {
    to: string;
    from: string;
    messagingServiceSid?: string;
    statusCallback?: string;
    body?: string;
    mediaUrl?: string[];
    contentSid?: string;
    contentVariables?: string;
  } = {
    to: toWhatsAppAddress(to),
    // This is the actual fix: pin the literal sender number so Twilio's
    // Messaging Service pool can never substitute a different user's
    // number for this send.
    from: toWhatsAppAddress(twilioNumber),
  };

  if (messagingServiceSid) {
    payload.messagingServiceSid = messagingServiceSid;
  }

  if (appBaseUrl) {
    payload.statusCallback = `${appBaseUrl}${
      opts.statusCallbackPath || "/api/send-sms/twilio/status"
    }`;
  }

  if (contentSid) {
    payload.contentSid = contentSid;
    if (opts.contentVariables) {
      payload.contentVariables = JSON.stringify(opts.contentVariables);
    }
  } else if (body) {
    payload.body = body;
  }

  if (mediaUrl.length > 0) {
    payload.mediaUrl = mediaUrl;
  }

  const msg = await client.messages.create(payload);

  return {
    sid: msg.sid,
    status: msg.status || "queued",
    from: stripWhatsAppPrefix(msg.from || twilioNumber),
  };
}
