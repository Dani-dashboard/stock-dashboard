# launchd Template

Purpose: run the stock dashboard fetch batch and Supabase Storage publish every 60 seconds without AI/chat involvement.

A separate active KOSPI200 option PCR job can refresh the heavier active ATM-window option probe every 10 minutes, then run `fetch + publish` once so Vercel sees the new PCR cache without putting the probe in the 1-minute loop.

A separate KRX official EOD PCR job refreshes the KOSPI200 options put/call ratio after the Korea close at 16:45, 18:30, and 20:00 KST. It uses `--write-ok-only`, so an empty current-day KRX response does not overwrite the last valid official EOD cache. This keeps the dashboard showing the previous official EOD value until the new day is available.

This is a template only. Do not install automatically without Dani confirmation.

Manual install steps if/when wanted:

```bash
cp docs/launchd/com.dani.stock-dashboard-fetch.plist.template ~/Library/LaunchAgents/com.dani.stock-dashboard-fetch.plist
launchctl load ~/Library/LaunchAgents/com.dani.stock-dashboard-fetch.plist
```

Stop:

```bash
launchctl unload ~/Library/LaunchAgents/com.dani.stock-dashboard-fetch.plist
```

Logs:

- `logs/launchd-fetch.out.log`
- `logs/launchd-fetch.err.log`
- `logs/launchd-active-pcr.out.log`
- `logs/launchd-active-pcr.err.log`
- `logs/launchd-krx-pcr-eod.out.log`
- `logs/launchd-krx-pcr-eod.err.log`

The job runs `npm run fetch && npm run publish:supabase`, which writes local snapshots and publishes public JSON for Vercel:

- `data/latest.json`
- bounded `data/health-history.jsonl` with last 500 snapshots
- Supabase Storage `stock-dashboard/data/latest.json`
- Supabase Storage `stock-dashboard/data/events.json`

Active PCR job install:

```bash
cp docs/launchd/com.dani.stock-dashboard-active-pcr.plist.template ~/Library/LaunchAgents/com.dani.stock-dashboard-active-pcr.plist
launchctl load ~/Library/LaunchAgents/com.dani.stock-dashboard-active-pcr.plist
```

Stop:

```bash
launchctl unload ~/Library/LaunchAgents/com.dani.stock-dashboard-active-pcr.plist
```

The active PCR job runs `npm run pcr:refresh`, which updates `data/kospi200-pcr-fullchain-probe.json`, then runs `npm run fetch && npm run publish:supabase`. It has its own lock directory so overlapping 10-minute launches skip safely.

KRX official EOD PCR job install:

```bash
cp docs/launchd/com.dani.stock-dashboard-krx-pcr-eod.plist.template ~/Library/LaunchAgents/com.dani.stock-dashboard-krx-pcr-eod.plist
launchctl load ~/Library/LaunchAgents/com.dani.stock-dashboard-krx-pcr-eod.plist
```

Stop:

```bash
launchctl unload ~/Library/LaunchAgents/com.dani.stock-dashboard-krx-pcr-eod.plist
```

The KRX EOD PCR job runs `npm run krx:pcr:eod:refresh`. It attempts the current KRX official daily options endpoint, writes only successful official PCR payloads, then runs `fetch + publish` so Vercel/Supabase keep showing the best available official EOD PCR.
