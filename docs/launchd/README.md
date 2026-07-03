# launchd Template

Purpose: run the stock dashboard fetch batch and Supabase Storage publish every 60 seconds without AI/chat involvement.

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

The job runs `npm run fetch && npm run publish:supabase`, which writes local snapshots and publishes public JSON for Vercel:

- `data/latest.json`
- bounded `data/health-history.jsonl` with last 500 snapshots
- Supabase Storage `stock-dashboard/data/latest.json`
- Supabase Storage `stock-dashboard/data/events.json`
