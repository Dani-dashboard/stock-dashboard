# Web Publishing Plan — Stock / Index Dashboard

> Purpose: 모바일에서 같은 URL로 대시보드를 보기 위한 배포/갱신 운영안.

## 1. Core principle

Do **not** redeploy HTML every minute.

Use this structure instead:

```text
index.html  = mostly static UI
latest.json = market snapshot refreshed every 60 seconds
```

The current dashboard already follows this model: `index.html` loads `data/latest.json` and schedules another load after `refreshSeconds`.

## 2. Current quick-access setup

Current test mode:

```text
Dani iMac
  ├─ python http.server on 127.0.0.1:8787
  ├─ scripts/run-every-minute.sh refreshes data/latest.json
  └─ cloudflared quick tunnel exposes the local server
```

This is good for same-day mobile testing.

Caveats:

- Quick Tunnel URL is temporary and has no uptime guarantee.
- iMac must stay awake and online.
- The URL is effectively public/unguarded unless a named tunnel + auth policy is added.
- No secrets are served directly, but market snapshots are public to anyone with the URL.

## 3. Recommended staged path

### Stage A — Quick mobile testing

Use Cloudflare Quick Tunnel.

Pros:

- Fastest to start.
- No domain required.
- KIS credentials stay local in `.env`.

Cons:

- Temporary URL.
- No production uptime guarantee.
- Needs iMac running.

### Stage B — Stable personal operation

Use one of:

1. Cloudflare named tunnel + Access policy
2. Tailscale Serve/Funnel if Dani already uses Tailscale

Recommended if the dashboard remains personal/private.

### Stage C — Production-like lightweight hosting

Use:

```text
Cloudflare Pages: index.html/static assets
Cloudflare Worker + KV/R2: latest.json endpoint
Dani iMac or trusted machine: 1-minute fetch + upload sanitized latest.json
```

Pros:

- Stable public URL.
- Optional custom domain.
- API keys remain local.
- Only sanitized data JSON is uploaded.

Cons:

- Requires Cloudflare account setup and a write token.

## 4. Domain decision

Do not buy a domain yet.

Use temporary/free URLs first:

- `*.trycloudflare.com` for quick tunnel
- `*.pages.dev` or `*.workers.dev` for Cloudflare-hosted version

Buy a domain only after 1–2 weeks of daily use or if Dani wants a memorable URL.

## 5. Security checklist before stable public use

- [ ] Confirm `data/latest.json` contains no credentials or account identifiers.
- [ ] Keep `.env` ignored and local only.
- [ ] Add basic auth / Cloudflare Access if using a stable public URL.
- [ ] Keep dashboard server bound to `127.0.0.1`, not `0.0.0.0`, when using tunnel.
- [ ] Do not expose KIS token cache.
- [ ] Consider serving only `index.html`, static assets, and `data/latest.json`.

## 6. Current recommendation

Use Quick Tunnel for immediate phone review, then migrate to Cloudflare named tunnel or Pages/Worker once UI/data reliability is acceptable.

## 7. Future UX layer — Events and 30-minute summaries

Dani's product direction on 2026-05-06:

- Add a UX-first event layer for today's key schedule and this week's key schedule.
- Make it easy to scan at a glance on mobile.
- If events are meaningful for the current market context, promote them toward the top of the dashboard.
- Longer-term: add a 30-minute market summary layer for sharp index moves, notable changes, and concise feature/summary cards.
- Efficiency guardrail: keep AI out of the 1-minute data fetch path. Any summary layer should start with deterministic change detection and run at lower frequency only when meaningful.
