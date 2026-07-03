# KIS Token and Key Lifecycle

## Access token

- KIS access token is valid for roughly 24 hours.
- Dashboard code does **not** request a new token every minute.
- `src/providers/kis.mjs` caches token at `data/kis-token-cache.json`.
- If token is missing/expired/within 10 minutes of expiry, it auto-refreshes.
- This means 1-minute batch can run safely without token spam.

## Mock investment app key / secret lifecycle

Dani mentioned paper/mock trading may be on a 3-month cycle. Current local metadata:

- `KIS_CREDENTIAL_ISSUED_AT=2026-04-30`
- `KIS_CREDENTIAL_EXPIRES_AT=2026-07-30`
- `KIS_CREDENTIAL_REMIND_DAYS=14`

If fewer than 14 days remain, the KIS status card should warn. If expired or auth fails, it should show a clear KIS key/token error instead of a generic dashboard failure.

## Commands

```bash
npm run kis:token
npm run kis:token:force
npm run kis:credential-status
```

## Display behavior

- Token OK + credential lifecycle OK: 🟢 normal
- Credential renewal window: 🟡 renewal reminder
- Expired/invalid app key/secret/token: 🔴 `KIS_KEY_OR_TOKEN_ERROR` / `KIS_KEY_EXPIRED`

## Reminder policy

Remind Dani before `KIS_CREDENTIAL_EXPIRES_AT`, ideally at 14 days remaining. Do not expose the actual secret values in chat/logs.
