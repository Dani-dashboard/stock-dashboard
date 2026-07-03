#!/usr/bin/env bash
set -euo pipefail

# Registers the durable OpenClaw job that refreshes the Osun weekly calendar.
# If this fails with `scope upgrade pending approval`, approve the Gateway cron scope
# in OpenClaw first, then rerun this script.

openclaw cron add \
  --name stock-dashboard-weekly-calendar-refresh \
  --description "Refresh stock-dashboard weekly schedule after Osun Sunday post" \
  --cron "10 20 * * 0" \
  --tz Asia/Seoul \
  --exact \
  --session isolated \
  --light-context \
  --model openai-codex/gpt-5.5 \
  --thinking medium \
  --timeout-seconds 900 \
  --tools "read write edit exec web_fetch" \
  --announce \
  --account default \
  --channel telegram \
  --to telegram:8518699807 \
  --message "Stock dashboard weekly calendar refresh. Work in /Users/dani/.openclaw/workspace/projects/stock-dashboard. Fetch https://r.jina.ai/http://r.jina.ai/http://https://www.youtube.com/@futuresnow/posts and identify the latest Osun weekly calendar for the upcoming trading week. If available, update data/events.json weeklyEvents only, preserving structuralEvents and keeping todayIssues empty unless there is a real current issue. Then run npm run check and npm run calendar:freshness, update logs/iteration-log.md and HANDOFF.md with the result. If the Osun source is inaccessible or validation fails, send Dani a concise Telegram update asking for the latest post text/image or manual source; do not silently pass."
