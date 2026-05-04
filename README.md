# 🚲 Auto Commute Blocker — Google Calendar

Automatically creates "Travel" blocks in Google Calendar before and after physical meetings, using real travel times (cycling or public transit) + a configurable buffer. Also handles long-distance trips: train/flight events generate access blocks to the station/airport, and multi-day stays automatically anchor subsequent meetings to the hotel.

Blocks show as **busy** → no one can book over your commute time.

---

## How it works

### Architecture

| Trigger | Frequency | Scope | Role |
|---|---|---|---|
| `onCalChange_` | ~30sec after each change | **Only the affected days** | Uses a sync token to detect which events changed. Processes only those days. Works even for a meeting 3 weeks out. |
| `scanUpcoming_` | Every 30min (configurable) | **Next 7 days** | Safety net. Catches anything the hook missed. |
| `morningSweep_` | Daily at 7am | **Today only** | Checks for unresolvable conflicts, sends email if needed. |

### Core logic — meetings

For each physical meeting of the day (sorted by time):

1. **Resolves origin** via timeline anchor: most recent train/flight destination → active hotel → previous meeting (if chained) → home/office.
2. **If destination = current anchor** → no travel block.
3. **Travel mode**: cycling if both points are within the configured city bounds and trip ≤ 45min, otherwise public transit.
4. **Google Directions API call** → real duration + buffer.
5. **Conflict resolution**: if travel overlaps a video call or "time block" → shifted before it automatically (recursive). If it overlaps a physical meeting → alert email.

### Intra-day returns

After each physical meeting, if the next physical meeting is more than 90min away:
- Calculates whether a round-trip (meeting → home/office → next meeting) fits in the gap.
- If yes → creates a return block.
- If no → no return, the next trip will be direct A→B.

### End-of-day return

- After the last physical meeting → return block.
- After the evening cutoff (configurable, default 5pm) → always to home (never office).
- If a hotel night is detected → return to hotel instead.

### Train / Flight events

Events whose title starts with a transit keyword (default: `Train`, `Flight`, `TGV`, `Vol`) followed by `to <destination>` are treated as transit, not as meetings. The script generates:

- **Arrival block**: anchor → station/airport, ending at the transit start time. Per-keyword platform buffer added (10min for trains, 90min for flights).
- **Departure block**: arrival station → home (or future hotel) at transit end — only if no follow-up physical meeting exists. Otherwise, the next meeting's own travel block handles the exit using the transit destination as anchor.

After a transit event ends, its destination becomes the timeline anchor for everything that follows that day, until another transit event fires.

### Hotel nights

Two formats are detected as hotel anchors:
- **Timed overnight events** — e.g. an event 10pm → 8am next day with a physical address.
- **All-day multi-day events with a location** — e.g. Google's auto-imported "Stay at The Standard, Brussels" events.

For multi-day all-day events, **the day the event starts is treated as a transit day**: hotel is *not* yet the anchor in the morning (you woke up at home). It only becomes the anchor after a transit event fires that day. From the next morning onward, the hotel is the anchor for all meetings until the stay ends.

### Office / Home (Google Workspace)

- If you have a Workspace account with "working location" configured → the script reads whether it's an office or home day and uses the corresponding address.
- If you're on personal Gmail → always home (automatic fallback).
- First meeting of the morning always departs from home (not office).

---

## Prerequisites

- A **Google account** with access to [Google Apps Script](https://script.google.com/)
- A **Google Cloud project** with billing enabled (free tier is sufficient)
- A **Google Maps API key**

---

## Setup

### Step 1 — Google Cloud Console

1. [console.cloud.google.com](https://console.cloud.google.com/) → create or select a project
2. Enable **billing**
3. **APIs & Services → Library** → enable:
   - Google Calendar API
   - Directions API
   - Geocoding API
4. **APIs & Services → Credentials** → create an **API Key**, restrict it to Directions + Geocoding

### Step 2 — Apps Script

1. [script.google.com](https://script.google.com/) → **New Project** → name it `Commute Blocker`
2. Delete the default code, paste the contents of `Code.gs`

### Step 3 — Calendar Advanced Service

1. Sidebar → **Services** (puzzle icon) → **+** → **Google Calendar API** → **Add**

### Step 4 — Link to GCP project

1. **Project Settings** (gear icon) → **Google Cloud Platform Project** → **Change project**
2. Enter your GCP project number

### Step 5 — Personalize Script Properties

**Project Settings → Script properties** — add these entries with your own values:

| Property | Example | Description |
|---|---|---|
| `HOME_ADDRESS` | `123 Main St, New York, NY 10001` | **Your home address** |
| `OFFICE_ADDRESS` | *(empty or your office address)* | Office address (optional, for Workspace users) |
| `BUFFER_MINUTES` | `10` | Buffer added to travel time (minutes) |
| `WATCH_CALENDAR_ID` | `primary` | Calendar to watch |
| `GOOGLE_MAPS_API_KEY` | `AIza...` | **Your Maps API key** (from step 1) |
| `POLL_INTERVAL_MINUTES` | `30` | Fallback polling frequency (minutes) |
| `DAY_START_HOUR` | `9` | Day start (24h format) |
| `FIRST_MEETING_WINDOW` | `90` | First meeting within this → depart from home (min) |
| `CHAIN_WINDOW_MINUTES` | `120` | Chaining window from previous meeting (min) |
| `NEXT_MEETING_WINDOW` | `90` | Min gap before creating an intra-day return (min) |
| `CYCLING_MAX_MINUTES` | `45` | Max cycling time before switching to transit |
| `EVENING_CUTOFF_HOUR` | `17` | After this hour → return home (not office) |
| `ALERT_EMAIL` | `you@email.com` | **Your email** for conflict alerts |
| `LOG_LEVEL` | `INFO` | Verbosity (`DEBUG` for troubleshooting) |
| `TRAVEL_COLOR_ID` | `8` | Block color (8 = graphite) |
| `TRANSIT_KEYWORDS` | `Train,Flight,TGV,Vol` | Title prefixes detected as transit (optional) |

> **No personal data is in the code.** All configuration lives in Script Properties.

### Step 6 — Authorize

1. Select `authKickstart` → **Run** → approve all permissions

### Step 7 — Install triggers

1. Select `setup` → **Run**
2. Verify (clock icon):
   - `onCalChange_` → Calendar event updated
   - `scanUpcoming_` → every 30 minutes
   - `morningSweep_` → daily at 7am

> Note: on first run, the sync token initializes. Travel blocks will start appearing from the **second** calendar change onward.

---

## Testing

| Test | Action | Expected result |
|---|---|---|
| Simple trip | Create a meeting with an address, wait ~30sec | `Travel 🚲 Xmin` block before the meeting |
| Distant meeting | Create a meeting 2-3 weeks out | Travel block created in ~30sec via `onCalChange_` |
| Chaining | 2 meetings in different locations, <2h apart | 1st trip from home, 2nd from meeting 1 location |
| Intra-day return | 2 meetings with >2h gap | Return block after meeting 1 |
| End-of-day return | 1 physical meeting | Return block after the meeting |
| Video call conflict | Video call just before a distant physical meeting | Travel shifts before the video call |
| Alert email | `sweepNow` with an unresolvable conflict | Email received |
| Hotel night (timed) | Event 10pm→8am next day with address | Last return goes to hotel |
| Hotel stay (multi-day) | All-day "Stay at X" event spanning 2+ days | Hotel becomes anchor from day 2 onward |
| Train trip | Event titled `Train to Brussels`, location = `Paris Nord` | Arrival block (home → Paris Nord, +10min platform); next-day meetings anchor from `Brussels` |
| Flight trip | Event titled `Flight to JFK`, location = airport | Arrival block with +90min airport buffer |

---

## Manual functions

| Function | Usage |
|---|---|
| `authKickstart()` | Approve permissions (once) |
| `setup()` | Install triggers (once) |
| `scanNow()` | Manual test — scan next 7 days |
| `sweepNow()` | Manual test — simulate morning sweep |
| `debugDay()` | Print everything the script sees on a specific date (edit `DEBUG_DATE`) |
| `debugListConsistency()` | Probe Calendar.Events.list freshness — diagnostic only |
| `emergencyCleanupTravelDuplicates()` | One-shot dedup over the next 60 days |

---

## Customization

### Adapt the travel mode

- **City bounding box**: edit `PARIS_BOUNDS` in the code for your city's lat/lng limits
- **Cycling threshold**: adjust `CYCLING_MAX_MINUTES` (default 45min)
- **Transit only**: set `CYCLING_MAX_MINUTES` to `0`
- **Cycling only**: set `CYCLING_MAX_MINUTES` to `999`

### Adapt the transit keywords

- Default keywords: `Train`, `Flight`, `TGV`, `Vol` (English + French)
- Override via `TRANSIT_KEYWORDS` script property (comma-separated)
- Per-keyword platform buffer is hardcoded in `TRANSIT_PLATFORM_BUFFERS` (Train/TGV: 10min, Flight/Vol: 90min)

### Google Calendar colors

| ID | Color |
|---|---|
| 1 | Lavender |
| 2 | Sage |
| 3 | Grape |
| 4 | Flamingo |
| 5 | Banana |
| 6 | Tangerine |
| 7 | Peacock |
| 8 | Graphite |
| 9 | Blueberry |
| 10 | Basil |
| 11 | Tomato |

---

## Naming convention

`Travel 🚲 25min` or `Travel 🚇 35min`

Description includes: origin → destination, mode, clickable Google Maps itinerary link. Blocks are graphite-colored and marked **busy**.

---

## Cost

| Service | Free tier | Estimated usage (~5 meetings/day) |
|---|---|---|
| Directions API | 1,000/month | ~220/month |
| Geocoding API | 1,000/month | ~100/month |
| Calendar API | 20,000/day | A few hundred |
| Apps Script | 90 min/day | ~30-60 min |

**Total: $0/month**

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `onEventUpdated` fails on setup | Re-run `setup()` 2-3 times. Intermittent Google issue. 30-min polling works as fallback. |
| Duplicate travel blocks | Should not happen — dedup uses the in-memory day snapshot, not a second list call. If it does, the executions log will show a `multiple matches in dayEvents — collapsing` WARN with full trace. Run `emergencyCleanupTravelDuplicates()` to clear any backlog. |
| No block created | Check: physical address in location field, meeting accepted, destination ≠ home. Set `LOG_LEVEL` to `DEBUG`. |
| No blocks on first run | Normal: sync token initializes on first run. Blocks appear from 2nd change. Run `scanNow()` to force. |
| Wrong transport mode | Cycling only if both points are in the bounding box AND ≤ 45min. |
| Working location ignored | Requires Google Workspace. Personal Gmail → always home. |
| Sync slower on mobile | Normal: Google Calendar on mobile syncs less frequently than desktop. |
| Hotel anchor used on day of arrival | Expected: on the day a multi-day stay starts, you're treated as still at home. The hotel becomes anchor only after a transit event fires (or from day 2 of the stay). |
| Train event treated as a meeting | Title must start with a transit keyword followed by ` to ` (e.g. `Train to Brussels`). Otherwise it's classified as a regular meeting. |

---

## Stack

Google Apps Script · Calendar API (Advanced) · Directions API · Geocoding API · CacheService · LockService

Based on [Auto Drive-Time Blocker](https://github.com/mathewvarghesemanu/drive_to_time_script_for_google_calendar) by Mathew Varghese (MIT License).
