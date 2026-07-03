# Email Alert Policy Draft

> Purpose: Evaluate whether urgent market-condition changes should trigger a title-only email to `hummingscape@gmail.com`.

## 1. Alert Scope

Current candidate alerts requested by Dani:

1. USD/KRW 급변
2. Foreign KOSPI200 futures position/flow 급변
3. KOSPI/KOSPI200/KOSPI200 futures 급격한 가격 변동
4. Foreign KOSPI cash flow 급변

Email style:

- Subject only should explain why it was sent.
- Body can be empty or a minimal machine footer if required by the sender.
- Do not send routine market updates.

## 2. Definition — USD/KRW 급변

Current email triggers:

- USD/KRW crosses below 5-day support or above 5-day resistance.
- USD/KRW changes by **±0.50% or more within 30 minutes**.

No email by default for 1-minute, 5-minute, or intraday-only USD/KRW moves.

## 3. Definition — KOSPI / KOSPI200 급변

Current email triggers:

- KOSPI cash index changes by **±1.00% or more within ~1 minute** during Korea cash-market window.
- KOSPI200 cash index changes by **±1.00% or more within ~1 minute** during Korea cash-market window.

No email by default for 5-minute or intraday-only KOSPI/KOSPI200 moves.

## 4. Definition — KOSPI200 Futures Price

Current policy:

- Do **not** send email for KOSPI200 day/night futures price moves.

## 5. Definition — Foreign Flow 급변

Current email triggers:

- Foreign KOSPI200 futures net flow changes by **±1조원 / ±1,000십억원 or more within 30 minutes**.
- Foreign KOSPI cash net flow changes by **±1조원 / ±1,000십억원 or more within 30 minutes**.

No email by default for 1-minute flow changes, sign flips, or absolute net-flow level alone.

## 6. Anti-Spam / Cooldown Rules

To avoid email spam:

- Per alert type cooldown: **30 minutes**.
- Do not resend same-direction alert unless cooldown expires and condition is still materially relevant.
- Store sent-alert state locally, e.g. `data/alert-state.json`.


## 7. Definition — KOSPI Market Safety Mechanisms

Highest-priority alerts:

- KOSPI sidecar buy/sell monitor: KOSPI200 day futures reaches **±5.00% or more** during the Korea day-futures window.
  - Positive move => buy-side sidecar alert.
  - Negative move => sell-side sidecar alert.
- Circuit-breaker monitor: KOSPI or KOSDAQ cash index decline reaches **-8% / -15% / -20%** during Korea cash-market window.

Delivery policy:

- Send via Gmail API email and Telegram.
- Bypass normal email market-hour window.
- Also show in `오늘의 이슈` as `korea_market_safety_mechanism`.
- Dashboard card TTL: **1 hour from first detection**.

Caveat:

- Current implementation is a deterministic threshold monitor based on dashboard market data, not yet an official KRX halt-announcement feed. Alert wording uses `발동권` until an official source is wired.

## 8. Sending Feasibility

### Option A — Gmail API

Pros:

- Official Google-supported method.
- More secure than storing SMTP passwords.
- Reliable, auditable.

Cons:

- Requires Google Cloud/OAuth setup and Gmail send scope.
- Needs token storage and refresh handling.

Reference:

- Gmail API supports sending via `users.messages.send` using RFC 2822 MIME messages encoded as base64URL.

### Option B — Gmail SMTP / app password

Pros:

- Simple with `msmtp`, nodemailer, or system mail relay.

Cons:

- Gmail no longer supports simple username/password for less-secure apps.
- App passwords require 2-Step Verification and are not the preferred modern method.
- Secret handling must be careful.

### Option C — Local macOS `mail` / `sendmail`

Observed locally:

- `/usr/bin/mail` exists.
- `/usr/sbin/sendmail` exists.

Pros:

- Already present on macOS.

Cons:

- Usually not configured for reliable outbound Gmail delivery by default.
- May fail silently or be blocked/spam-classified without SMTP relay.
- Needs testing and configuration.

## 9. Recommendation

Recommended path:

1. Implement **alert detection only** first, no email.
2. Write would-send alerts to `data/alerts-latest.json` and maybe dashboard `오늘의 이슈`.
3. After Dani confirms thresholds, add email sender.
4. Prefer Gmail API or an explicit SMTP relay, not ad-hoc local sendmail.
5. Require explicit approval before enabling actual outbound email.

## 10. Current Implementation

MVP files:

- `scripts/check-alerts.mjs`
  - Reads `data/latest.json`.
  - Reads/writes `data/alert-state.json`.
  - Emits subject-only alert candidates.
- `data/alerts-latest.json`
  - Stores latest alert candidate and last sent status.
- Optional later:
  - `scripts/send-email-alert.mjs` after Gmail/API/SMTP decision.

MVP loop:

```text
1-minute fetch loop
  → data/latest.json
  → deterministic alert checker every 1–5 minutes
  → if trigger and cooldown passed: send title-only email or store would-send candidate
```

No AI/Codex in this path.

Current operational notes:

- `scripts/run-every-minute.sh` runs `npm run fetch` then `npm run alerts` every minute.
- `.env.alerts` controls actual sending with `ALERT_EMAIL_ENABLED=1`.
- Primary provider is Gmail API; local sendmail is configured as fallback because Gmail OAuth can expire or be revoked.
- Gmail API currently needs reauthorization if test sends fail with `invalid_grant`.
