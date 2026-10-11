# Blum SaaS

SMS marketing platform for UAE (+971) numbers. Started as a copy of nexgen-admin.

## First steps
1. Move this folder out of nexgen-admin, then `git init`.
2. Create a NEW Firebase project (do not reuse nexgen-sms): `firebase use --add`.
3. Create `.env.local` with the new project's keys (nothing is copied from nexgen).
4. `npm install` then `npm run dev`.
5. Choose the SMS provider for UAE before changing the send code.

## US-specific code to replace
- Phone validation / formatting (`lib/phone.ts` and friends): +1 and 10 digits.
- STOP / HELP and 10DLC compliance logic in the inbound webhook.
- Twilio-only send path and carrier-fee/billing assumptions (USD).
- Branding, logo, copy ("Nexgen").

## Env vars needed in .env.local
NEXT_PUBLIC_FIREBASE_API_KEY, NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
NEXT_PUBLIC_FIREBASE_PROJECT_ID, NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID, NEXT_PUBLIC_FIREBASE_APP_ID,
NEXT_PUBLIC_FIREBASE_VAPID_KEY, plus FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
(Admin SDK) and the SMS provider keys.
Also replace the REPLACE_WITH_BLUM_* values in public/firebase-messaging-sw.js.
