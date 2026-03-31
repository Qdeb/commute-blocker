/** ------------------------------------------------------------
 * Auto Commute Blocker for Google Calendar — V3
 * 
 * Creates "Travel" time blocks before/after meetings with physical locations.
 * Chains meetings (origin = previous meeting location, not always home).
 * Cycling in Paris (<45min), transit otherwise.
 * Auto-shifts travel before virtual meetings when overlap detected.
 * Intra-day returns: if gap between meetings allows round-trip home, adds return.
 * Hotel nights: if an event spanning overnight has a location, use it as anchor.
 * After 17h: always return home (not office).
 * Emails alerts only for unresolvable conflicts.
 * 
 * Based on Auto Drive-Time Blocker by Mathew Varghese (MIT License).
 *
 * SCRIPT PROPERTIES (Project Settings → Script properties):
 *   HOME_ADDRESS           -> "Your home address"
 *   OFFICE_ADDRESS         -> "" (optional — set to office address for Workspace users)
 *   BUFFER_MINUTES         -> "10"
 *   WATCH_CALENDAR_ID      -> "primary"
 *   GOOGLE_MAPS_API_KEY    -> Directions API key
 *   SCAN_LOOKAHEAD_HOURS   -> "730" (default ~1 month)
 *   POLL_INTERVAL_MINUTES  -> "30" (fallback polling frequency; onCalChange_ handles real-time)
 *   DAY_START_HOUR         -> "9"
 *   FIRST_MEETING_WINDOW   -> "90"
 *   CHAIN_WINDOW_MINUTES   -> "120"
 *   NEXT_MEETING_WINDOW    -> "90"
 *   CYCLING_MAX_MINUTES    -> "45"
 *   EVENING_CUTOFF_HOUR    -> "17" (after this hour, always return home not office)
 *   ALERT_EMAIL            -> "your@email.com"
 *   LOG_LEVEL              -> "INFO"
 *   TRAVEL_COLOR_ID        -> "8"
 *
 * SETUP:
 *   1. Apps Script: Services → + → Calendar API (Advanced)
 *   2. GCP Console: enable Calendar API + Directions API + Geocoding API
 *   3. Set script properties
 *   4. Run authKickstart() → approve permissions
 *   5. Run setup() → installs triggers
 * ------------------------------------------------------------ */

// ===================== LOGGING =====================

const PROPS = PropertiesService.getScriptProperties();
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };

function getLogLevel_() {
  const lvl = (PROPS.getProperty('LOG_LEVEL') || 'INFO').toUpperCase();
  return LOG_LEVELS[lvl] ?? LOG_LEVELS.INFO;
}
function mask_(s, keep = 4) {
  if (!s) return s;
  const str = String(s);
  return str.length <= keep ? '****' : `${str.slice(0, keep)}****`;
}
function nowIso_() { return new Date().toISOString(); }
function durMs_(t0) { return Date.now() - t0; }
function slog_(level, msg, ctx) {
  const want = getLogLevel_();
  if (LOG_LEVELS[level] > want) return;
  const payload = ctx ? ` ${JSON.stringify(ctx)}` : '';
  const line = `[${nowIso_()}] [${level}] ${msg}${payload}`;
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}
const logE = (m, c) => slog_('ERROR', m, c);
const logW = (m, c) => slog_('WARN',  m, c);
const logI = (m, c) => slog_('INFO',  m, c);
const logD = (m, c) => slog_('DEBUG', m, c);

// ===================== UTILS =====================

function getProp_(key, fallback) {
  const v = PROPS.getProperty(key);
  return (v == null ? (fallback ?? '') : String(v)).trim();
}
function getNumProp_(key, fallback) {
  return parseInt(getProp_(key, String(fallback)), 10) || fallback;
}
function minutes_(n) { return n * 60 * 1000; }
function hours_(n)   { return n * 60 * 60 * 1000; }

function hasPhysicalLocation_(ev) {
  const loc = (ev.location || '').trim();
  if (!loc) return false;
  if (/^https?:\/\//i.test(loc)) return false;
  if (/^(meet\.google|zoom\.us|teams\.microsoft)/i.test(loc)) return false;
  return true;
}
function isAccepted_(ev) {
  if (!ev.attendees || ev.attendees.length === 0) return true;
  const me = ev.attendees.find(a => a.self);
  if (!me) return true;
  return me.responseStatus === 'accepted' || me.responseStatus === 'tentative';
}
function isUserTimeBlock_(ev) {
  return (ev.summary || '').toLowerCase().includes('time block');
}
function shortPlace_(loc) {
  return (loc || '').split(',')[0].trim() || loc || 'destination';
}
function mapsUrl_(origin, destination, mode) {
  const base = 'https://www.google.com/maps/dir/?api=1';
  return `${base}&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=${mode === 'bicycling' ? 'bicycling' : 'transit'}`;
}

/**
 * Normalize an address for comparison.
 * Lowercase, trim, remove trailing country, collapse whitespace.
 */
function normalizeAddr_(addr) {
  return (addr || '').toLowerCase().trim().replace(/,?\s*france\s*$/i, '').replace(/\s+/g, ' ').trim();
}

/** Check if two addresses refer to the same place (fuzzy). */
function sameLocation_(a, b) {
  return normalizeAddr_(a) === normalizeAddr_(b);
}

/**
 * Get the "anchor" location (home or office) for a specific date/time.
 * 
 * Tries to read Google Workspace working location events.
 * - If a workingLocation event exists for this time with type 'officeLocation' → return OFFICE_ADDRESS
 * - If a workingLocation event exists with type 'homeOffice' → return HOME_ADDRESS
 * - If no working location events (Gmail personal) → fallback to HOME_ADDRESS
 * 
 * Requires OFFICE_ADDRESS script property to be set for office mode.
 * Results cached per date to avoid repeated API calls.
 */
function getAnchorForTime_(calId, dateTime) {
  const home = getProp_('HOME_ADDRESS');
  const office = getProp_('OFFICE_ADDRESS', '');
  
  // If no office address configured, always return home
  if (!office) return home;

  const dateStr = dateTime.toISOString().substring(0, 10);
  const cache = CacheService.getScriptCache();
  const cacheKey = `anchor|${dateStr}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached === 'office' ? office : home;

  try {
    // Query workingLocation events for this day
    const dayStart = new Date(dateStr + 'T00:00:00');
    const dayEnd = new Date(dayStart.getTime() + hours_(24));
    
    const resp = Calendar.Events.list(calId, {
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
      eventTypes: ['workingLocation'],
      maxResults: 10,
      orderBy: 'startTime'
    });

    const wlEvents = resp.items || [];
    
    if (wlEvents.length === 0) {
      // No working location events → personal Gmail, fallback to home
      cache.put(cacheKey, 'home', 3600);
      return home;
    }

    // Find the working location event that covers the requested time
    const targetMs = dateTime.getTime();
    for (const ev of wlEvents) {
      const evStart = ev.start?.dateTime ? new Date(ev.start.dateTime).getTime() 
                    : ev.start?.date ? new Date(ev.start.date).getTime() : 0;
      const evEnd = ev.end?.dateTime ? new Date(ev.end.dateTime).getTime()
                  : ev.end?.date ? new Date(ev.end.date).getTime() : Infinity;
      
      if (targetMs >= evStart && targetMs < evEnd) {
        const wlProps = ev.workingLocationProperties;
        if (wlProps) {
          if (wlProps.officeLocation) {
            logD('getAnchorForTime_: office day', { date: dateStr, label: wlProps.officeLocation.label });
            cache.put(cacheKey, 'office', 3600);
            return office;
          }
          if (wlProps.homeOffice !== undefined) {
            logD('getAnchorForTime_: home day', { date: dateStr });
            cache.put(cacheKey, 'home', 3600);
            return home;
          }
        }
      }
    }

    // No matching working location → default to home
    cache.put(cacheKey, 'home', 3600);
    return home;
  } catch (e) {
    // API error (likely personal Gmail without Workspace) → fallback to home
    logD('getAnchorForTime_: working location not available, using home', { error: e.message });
    cache.put(cacheKey, 'home', 3600);
    return home;
  }
}

const PARIS_BOUNDS = {
  latMin: 48.815, latMax: 48.902,
  lngMin: 2.225,  lngMax: 2.420
};

// ===================== AUTH & SETUP =====================

function authKickstart() {
  logI('authKickstart: requesting scopes');
  CalendarApp.getDefaultCalendar();
  MailApp.getRemainingDailyQuota();
  logI('authKickstart: done — now run setup()');
}

function setup() {
  const t0 = Date.now();
  logI('setup: starting');
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  logI('setup: cleared existing triggers');

  const userEmail = Session.getEffectiveUser().getEmail();
  logI('setup: user email', { email: userEmail });

  try {
    ScriptApp.newTrigger('onCalChange_').forUserCalendar(userEmail).onEventUpdated().create();
    logI('setup: onEventUpdated trigger installed');
  } catch (e) {
    logW('setup: onEventUpdated failed, polling only', { error: e.message });
  }

  const pollMinutes = getNumProp_('POLL_INTERVAL_MINUTES', 30);
  ScriptApp.newTrigger('scanUpcoming_').timeBased().everyMinutes(pollMinutes).create();
  ScriptApp.newTrigger('morningSweep_').timeBased().atHour(7).everyDays(1).create();
  logI('setup: all triggers installed', { pollMinutes, durationMs: durMs_(t0) });
}

// ===================== TRIGGER HANDLERS =====================

function onCalChange_(e) {
  const t0 = Date.now();
  try {
    // Use incremental sync to find which events changed, then process only those days
    const changedDates = getChangedDates_();
    if (changedDates.length === 0) {
      // Fallback: if sync token fails, scan next 7 days
      logI('onCalChange_: no sync data, scanning 7 days');
      scanDays_(7);
    } else {
      logI('onCalChange_: processing changed dates', { dates: changedDates });
      for (const dateStr of changedDates) {
        try { processSingleDay_(dateStr); }
        catch (err) { logW('onCalChange_: day error', { date: dateStr, error: err.message }); }
      }
    }
  } catch (err) {
    logE('onCalChange_: error, falling back to 7-day scan', { error: err.message });
    try { scanDays_(7); } catch (e2) {}
  } finally {
    logD('onCalChange_: done', { durationMs: durMs_(t0) });
  }
}

/**
 * Incremental sync: uses a sync token to get only events that changed since last check.
 * Returns an array of unique date strings (YYYY-MM-DD) that need reprocessing.
 */
function getChangedDates_() {
  const calId = getProp_('WATCH_CALENDAR_ID', 'primary');
  const props = PropertiesService.getUserProperties();
  const syncToken = props.getProperty('SYNC_TOKEN');
  const dates = new Set();

  try {
    let resp;
    if (syncToken) {
      try {
        resp = Calendar.Events.list(calId, { syncToken: syncToken });
      } catch (e) {
        // Sync token expired (410 error) → do a full init to get a new token
        logI('getChangedDates_: sync token expired, reinitializing');
        initSyncToken_();
        return []; // caller will fallback to scanDays_
      }
    } else {
      // First run: initialize the sync token without processing anything
      initSyncToken_();
      return [];
    }

    // Extract dates from changed events
    const items = resp.items || [];
    for (const ev of items) {
      const dt = ev.start?.dateTime || ev.start?.date;
      if (dt) dates.add(dt.substring(0, 10));
      // Also check original start (for moved events)
      const odt = ev.originalStartTime?.dateTime || ev.originalStartTime?.date;
      if (odt) dates.add(odt.substring(0, 10));
    }

    // Store the new sync token for next time
    if (resp.nextSyncToken) {
      props.setProperty('SYNC_TOKEN', resp.nextSyncToken);
    }
  } catch (e) {
    logW('getChangedDates_: error', { error: e.message });
  }

  return Array.from(dates);
}

/**
 * Initialize sync token by doing a full list (without processing).
 * We need to paginate to get the final nextSyncToken.
 */
function initSyncToken_() {
  const calId = getProp_('WATCH_CALENDAR_ID', 'primary');
  const props = PropertiesService.getUserProperties();
  const now = new Date();

  let pageToken;
  let syncToken;
  do {
    const resp = Calendar.Events.list(calId, {
      timeMin: now.toISOString(),
      pageToken: pageToken
    });
    syncToken = resp.nextSyncToken;
    pageToken = resp.nextPageToken;
  } while (pageToken);

  if (syncToken) {
    props.setProperty('SYNC_TOKEN', syncToken);
    logI('initSyncToken_: initialized');
  }
}

/**
 * Process a single day by date string (YYYY-MM-DD).
 * Fetches all events for that day and runs processDayChain_.
 */
function processSingleDay_(dateStr) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    logD('processSingleDay_: skipped, locked');
    return;
  }

  const calId = getProp_('WATCH_CALENDAR_ID', 'primary');
  const dayStart = new Date(dateStr + 'T00:00:00');
  const dayEnd = new Date(dayStart.getTime() + hours_(24));

  try {
    const resp = Calendar.Events.list(calId, {
      timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(),
      singleEvents: true, maxResults: 250, orderBy: 'startTime'
    });
    const events = resp.items || [];
    logI('processSingleDay_: fetched', { date: dateStr, count: events.length });
    processDayChain_(calId, events, false);
  } catch (e) {
    logE('processSingleDay_: error', { date: dateStr, error: e.message });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Scan N days ahead. Used by poll (7 days) and deep scan (30 days).
 */
function scanDays_(days) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    logD('scanDays_: skipped, locked');
    return;
  }

  const t0 = Date.now();
  const calId = getProp_('WATCH_CALENDAR_ID', 'primary');
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const maxT = new Date(dayStart.getTime() + hours_(days * 24));

  try {
    const resp = Calendar.Events.list(calId, {
      timeMin: dayStart.toISOString(), timeMax: maxT.toISOString(),
      singleEvents: true, maxResults: 250, orderBy: 'startTime'
    });
    const allEvents = resp.items || [];
    logI('scanDays_: fetched', { days, count: allEvents.length });

    const dayGroups = groupByDate_(allEvents);
    for (const [dateStr, events] of Object.entries(dayGroups)) {
      try { processDayChain_(calId, events, false); }
      catch (e) { logE('scanDays_: chain error', { date: dateStr, error: e.message }); }
    }
  } catch (e) {
    logE('scanDays_: list failed', { error: e.message });
  } finally {
    lock.releaseLock();
  }
  logI('scanDays_: done', { days, durationMs: durMs_(t0) });
}

/** Poll trigger: scans next 7 days. */
function scanUpcoming_() {
  scanDays_(7);
}

function morningSweep_() {
  const t0 = Date.now();
  logI('morningSweep_: starting');
  const calId = getProp_('WATCH_CALENDAR_ID', 'primary');
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + hours_(24));

  try {
    const resp = Calendar.Events.list(calId, {
      timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(),
      singleEvents: true, maxResults: 250, orderBy: 'startTime'
    });
    const conflicts = processDayChain_(calId, resp.items || [], true);
    if (conflicts && conflicts.length > 0) sendConflictEmail_(conflicts, now);
    else logI('morningSweep_: no conflicts');
  } catch (e) {
    logE('morningSweep_: error', { error: e.message });
  }
  logI('morningSweep_: done', { durationMs: durMs_(t0) });
}

function scanNow() { console.log('scanNow()'); scanUpcoming_(); }
function sweepNow() { console.log('sweepNow()'); morningSweep_(); }

// ===================== CORE CHAIN LOGIC =====================

function groupByDate_(events) {
  const groups = {};
  for (const ev of events) {
    const dt = ev.start?.dateTime;
    if (!dt) continue;
    const dateStr = dt.substring(0, 10);
    if (!groups[dateStr]) groups[dateStr] = [];
    groups[dateStr].push(ev);
  }
  return groups;
}

/**
 * Detect a hotel night: an event that spans overnight with a physical address.
 * Returns the hotel address or null.
 */
function findHotelNight_(dayEvents, dateStr) {
  for (const ev of dayEvents) {
    if (!ev.start?.dateTime || !ev.end?.dateTime) continue;
    if (!hasPhysicalLocation_(ev)) continue;
    const start = new Date(ev.start.dateTime);
    const end = new Date(ev.end.dateTime);
    // Spans overnight: starts in the evening and ends the next day (or later)
    const startDate = start.toISOString().substring(0, 10);
    const endDate = end.toISOString().substring(0, 10);
    if (startDate === dateStr && endDate > dateStr) {
      return ev.location.trim();
    }
    // Or started the day before and ends today
    if (startDate < dateStr && endDate >= dateStr) {
      return ev.location.trim();
    }
  }
  return null;
}

/**
 * Process a single day's events as an ordered chain.
 * 
 * New in V3:
 *   - Intra-day returns: after each physical meeting, if gap to next > 90min
 *     AND there's time for a round-trip (return + depart), add return block.
 *     If round-trip doesn't fit, keep direct A→B (chain extends to cover gap).
 *   - After 17h: always return home.
 *   - Hotel nights: use hotel address as anchor instead of home.
 *   - Duplicate fix: findTravelBlockFor_ uses full-day window.
 */
function processDayChain_(calId, dayEvents, isMorningSweep) {
  const home = getProp_('HOME_ADDRESS');
  const apiKey = getProp_('GOOGLE_MAPS_API_KEY');
  const bufferMin = getNumProp_('BUFFER_MINUTES', 10);
  const dayStartHour = getNumProp_('DAY_START_HOUR', 9);
  const firstMeetingWindow = getNumProp_('FIRST_MEETING_WINDOW', 90);
  const chainWindow = getNumProp_('CHAIN_WINDOW_MINUTES', 120);
  const nextMeetingWindow = getNumProp_('NEXT_MEETING_WINDOW', 90);
  const eveningCutoff = getNumProp_('EVENING_CUTOFF_HOUR', 17);

  if (!home || !apiKey) {
    logW('processDayChain_: missing config');
    return [];
  }

  // Get the date string for hotel detection
  const dateStr = dayEvents[0]?.start?.dateTime?.substring(0, 10) || '';

  // Check for hotel night (overrides home as anchor for end-of-day)
  const hotelAddress = findHotelNight_(dayEvents, dateStr);
  if (hotelAddress) logI('processDayChain_: hotel night detected', { hotel: shortPlace_(hotelAddress) });

  // Full-day window for finding existing travel blocks (FIX: wider search to prevent duplicates)
  const dayWindowStart = dateStr ? new Date(dateStr + 'T00:00:00') : new Date(Date.now() - hours_(24));
  const dayWindowEnd = dateStr ? new Date(new Date(dateStr + 'T00:00:00').getTime() + hours_(36)) : new Date(Date.now() + hours_(48));

  // Filter: timed, accepted events
  const timedEvents = dayEvents.filter(ev => ev.start?.dateTime && isAccepted_(ev));

  // Classify
  const physicalMeetings = [];
  const existingTravelBlocks = [];
  const virtualMeetings = [];
  const userTimeBlocks = [];
  const otherEvents = [];

  for (const ev of timedEvents) {
    if (isTravelBlock_(ev)) existingTravelBlocks.push(ev);
    else if (isUserTimeBlock_(ev)) userTimeBlocks.push(ev);
    else if (hasPhysicalLocation_(ev)) physicalMeetings.push(ev);
    else virtualMeetings.push(ev);
  }

  physicalMeetings.sort((a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));
  const allNonTravelEvents = [...physicalMeetings, ...virtualMeetings, ...userTimeBlocks, ...otherEvents];

  logD('processDayChain_: classified', {
    physical: physicalMeetings.length, virtual: virtualMeetings.length,
    timeBlocks: userTimeBlocks.length, travel: existingTravelBlocks.length
  });

  const neededTravelBlockIds = new Set();
  const conflicts = [];

  for (let i = 0; i < physicalMeetings.length; i++) {
    const meeting = physicalMeetings[i];
    const meetingStart = new Date(meeting.start.dateTime);
    const meetingEnd = new Date(meeting.end.dateTime);
    const destination = meeting.location.trim();

    // ---- RESOLVE ORIGIN ----
    // Get the anchor (home or office) for this meeting's time
    const anchor = getAnchorForTime_(calId, meetingStart);
    let origin = anchor;
    if (i > 0) {
      const prevMeeting = physicalMeetings[i - 1];
      const prevEnd = new Date(prevMeeting.end.dateTime);
      const gap = meetingStart.getTime() - prevEnd.getTime();

      if (gap <= minutes_(nextMeetingWindow)) {
        // Short gap: direct chain A→B
        origin = prevMeeting.location.trim();
      } else if (gap <= minutes_(chainWindow)) {
        // Medium gap: check if round-trip to anchor fits
        const prevLoc = prevMeeting.location.trim();
        const returnDuration = getTravelDuration_(prevLoc, anchor, apiKey);
        const departDuration = getTravelDuration_(anchor, destination, apiKey);

        if (returnDuration != null && departDuration != null) {
          const roundTripMs = returnDuration + departDuration + 2 * minutes_(bufferMin);
          if (roundTripMs <= gap) {
            origin = anchor;
          } else {
            origin = prevLoc;
            logI('processDayChain_: round-trip too long, direct chain', {
              gap: Math.round(gap / 60000),
              roundTrip: Math.round(roundTripMs / 60000)
            });
          }
        } else {
          origin = prevLoc;
        }
      }
      // gap > chainWindow → origin stays as anchor
    }

    // First meeting within window of day start → always home (not office — you just woke up)
    if (i === 0) {
      const dayDate = new Date(meeting.start.dateTime);
      const dayStartTime = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), dayStartHour, 0, 0);
      if (meetingStart.getTime() - dayStartTime.getTime() <= minutes_(firstMeetingWindow)) {
        origin = home;
      }
    }

    // Skip if same location or destination is the current anchor
    if (sameLocation_(origin, destination) || sameLocation_(destination, anchor)) {
      removeTravelBlockFor_(calId, meeting.id, dayWindowStart, dayWindowEnd);
      continue;
    }

    // ---- COMPUTE TRAVEL ----
    const modeResult = determineTravelMode_(origin, destination, apiKey);
    if (!modeResult) { logW('processDayChain_: no mode', { meetingId: meeting.id }); continue; }

    const totalMs = modeResult.durationMs + minutes_(bufferMin);
    let travelEnd = meetingStart;
    let travelStart = new Date(travelEnd.getTime() - totalMs);

    // Conflict resolution
    const resolution = resolveOverlaps_(travelStart, travelEnd, allNonTravelEvents, meeting.id, calId, 0);
    travelStart = resolution.travelStart;
    travelEnd = resolution.travelEnd;

    neededTravelBlockIds.add(meeting.id);
    upsertTravelBlock_(calId, meeting.id, travelStart, travelEnd, origin, destination, modeResult.mode, mapsUrl_(origin, destination, modeResult.mode), dayWindowStart, dayWindowEnd);

    if (!resolution.resolved && resolution.unresolvableOverlaps.length > 0) {
      conflicts.push({
        meeting: meeting.summary || 'Untitled',
        meetingStart: meetingStart.toISOString(),
        travelStart: travelStart.toISOString(), travelEnd: travelEnd.toISOString(),
        travelMode: modeResult.mode,
        origin: shortPlace_(origin), destination: shortPlace_(destination),
        overlaps: resolution.unresolvableOverlaps.map(o => ({
          summary: o.summary || 'Untitled', start: o.start.dateTime, end: o.end.dateTime,
          isVirtual: !hasPhysicalLocation_(o)
        }))
      });
    }

    // ---- INTRA-DAY RETURN after this meeting ----
    const nextPhysical = physicalMeetings[i + 1];
    // Return anchor = home or office depending on Workspace working location
    // But after evening cutoff → always home (not office)
    const returnAnchor = (meetingEnd.getHours() >= eveningCutoff) ? home : anchor;

    if (!sameLocation_(destination, returnAnchor)) {
      let shouldCreateReturn = false;
      const returnId = meeting.id + '_return';

      if (!nextPhysical) {
        // Last meeting of the day → always return
        // After 17h → home, otherwise → anchor (home for now)
        shouldCreateReturn = true;
      } else {
        const nextStart = new Date(nextPhysical.start.dateTime);
        const gap = nextStart.getTime() - meetingEnd.getTime();

        if (gap > minutes_(nextMeetingWindow)) {
          // Big enough gap — check if round-trip fits
          const returnDuration = getTravelDuration_(destination, returnAnchor, apiKey);
          const departDuration = getTravelDuration_(returnAnchor, nextPhysical.location.trim(), apiKey);

          if (returnDuration != null && departDuration != null) {
            const roundTripMs = returnDuration + departDuration + 2 * minutes_(bufferMin);
            if (roundTripMs <= gap) {
              shouldCreateReturn = true;
            } else {
              logD('processDayChain_: no return, round-trip too long', {
                gap: Math.round(gap / 60000), roundTrip: Math.round(roundTripMs / 60000)
              });
            }
          }
        }
        // gap <= nextMeetingWindow → no return (direct chain to next meeting)
      }

      if (shouldCreateReturn) {
        // Return destination: after evening cutoff → home (or hotel if hotel night)
        // Before evening cutoff → anchor (home or office per Workspace)
        let returnDest = returnAnchor;
        if (meetingEnd.getHours() >= eveningCutoff && hotelAddress) {
          returnDest = hotelAddress;
        }

        if (!sameLocation_(destination, returnDest)) {
          const retMode = determineTravelMode_(destination, returnDest, apiKey);
          if (retMode) {
            const retTotalMs = retMode.durationMs + minutes_(bufferMin);
            const retStart = meetingEnd;
            const retEnd = new Date(retStart.getTime() + retTotalMs);
            upsertTravelBlock_(calId, returnId, retStart, retEnd, destination, returnDest, retMode.mode, mapsUrl_(destination, returnDest, retMode.mode), dayWindowStart, dayWindowEnd);
            neededTravelBlockIds.add(returnId);
          }
        }
      } else {
        // No return needed — clean up any existing return block
        removeTravelBlockFor_(calId, returnId, dayWindowStart, dayWindowEnd);
      }
    }
  }

  // Cleanup orphaned travel blocks
  for (const block of existingTravelBlocks) {
    const forId = block.extendedProperties?.private?.travelForEventId;
    if (forId && !neededTravelBlockIds.has(forId)) {
      try {
        Calendar.Events.remove(calId, block.id);
        logI('processDayChain_: cleaned orphan', { blockId: block.id, forEventId: forId });
      } catch (e) {
        logW('processDayChain_: cleanup failed', { blockId: block.id, error: e.message });
      }
    }
  }

  return conflicts;
}

// ===================== TRAVEL DURATION HELPER =====================

/**
 * Get travel duration (ms) between two points, using the mode selection logic.
 * Convenience wrapper used for round-trip feasibility checks.
 */
function getTravelDuration_(origin, destination, apiKey) {
  const result = determineTravelMode_(origin, destination, apiKey);
  return result ? result.durationMs : null;
}

// ===================== OVERLAP RESOLUTION =====================

function resolveOverlaps_(travelStart, travelEnd, allEvents, excludeEventId, calId, depth) {
  const MAX_DEPTH = 5;
  const travelDuration = travelEnd.getTime() - travelStart.getTime();
  const overlaps = findOverlaps_(travelStart, travelEnd, allEvents, excludeEventId);

  if (overlaps.length === 0) {
    return { resolved: true, travelStart, travelEnd, unresolvableOverlaps: [] };
  }
  if (depth >= MAX_DEPTH) {
    logW('resolveOverlaps_: max depth', { depth });
    return { resolved: false, travelStart, travelEnd, unresolvableOverlaps: overlaps };
  }

  const shiftable = [];
  const unresolvable = [];
  for (const ov of overlaps) {
    if (hasPhysicalLocation_(ov)) unresolvable.push(ov);
    else shiftable.push(ov);
  }

  if (unresolvable.length > 0) {
    return { resolved: false, travelStart, travelEnd, unresolvableOverlaps: unresolvable };
  }

  const earliestStart = shiftable.reduce((min, ev) => {
    const t = new Date(ev.start.dateTime).getTime();
    return t < min ? t : min;
  }, Infinity);

  const newTravelEnd = new Date(earliestStart);
  const newTravelStart = new Date(newTravelEnd.getTime() - travelDuration);

  logI('resolveOverlaps_: shift', {
    oldStart: travelStart.toISOString(), newStart: newTravelStart.toISOString(), depth: depth + 1
  });

  return resolveOverlaps_(newTravelStart, newTravelEnd, allEvents, excludeEventId, calId, depth + 1);
}

// ===================== TRAVEL MODE SELECTION =====================

function determineTravelMode_(origin, destination, apiKey) {
  const cyclingMax = getNumProp_('CYCLING_MAX_MINUTES', 45);
  const originInParis = isInParis_(origin, apiKey);
  const destInParis = isInParis_(destination, apiKey);

  if (originInParis && destInParis) {
    const cd = getDirectionsDuration_(origin, destination, 'bicycling', apiKey);
    if (cd != null && cd <= minutes_(cyclingMax)) {
      return { mode: 'bicycling', durationMs: cd };
    }
  }
  const td = getDirectionsDuration_(origin, destination, 'transit', apiKey);
  if (td != null) return { mode: 'transit', durationMs: td };

  const fb = getDirectionsDuration_(origin, destination, 'bicycling', apiKey);
  if (fb != null) return { mode: 'bicycling', durationMs: fb };

  logE('determineTravelMode_: all failed', { origin: shortPlace_(origin), destination: shortPlace_(destination) });
  return null;
}

function isInParis_(location, apiKey) {
  const cache = CacheService.getScriptCache();
  const cacheKey = `geo|${location}`;
  const cached = cache.get(cacheKey);
  if (cached != null) return cached === 'true';
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${apiKey}`;
    const data = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText());
    if (data.status !== 'OK' || !data.results?.length) { cache.put(cacheKey, 'false', 86400); return false; }
    const geo = data.results[0].geometry.location;
    const inParis = geo.lat >= PARIS_BOUNDS.latMin && geo.lat <= PARIS_BOUNDS.latMax
                 && geo.lng >= PARIS_BOUNDS.lngMin && geo.lng <= PARIS_BOUNDS.lngMax;
    cache.put(cacheKey, String(inParis), 86400);
    return inParis;
  } catch (e) { logW('isInParis_: error', { error: e.message }); return false; }
}

// ===================== DIRECTIONS API =====================

function getDirectionsDuration_(origin, destination, mode, apiKey) {
  const cache = CacheService.getScriptCache();
  const cacheKey = `dir|${mode}|${origin}|${destination}|${new Date().getHours()}`;
  const cached = cache.get(cacheKey);
  if (cached) return parseInt(cached, 10);

  const params = { origin, destination, mode, key: apiKey };
  if (mode === 'transit') params.departure_time = Math.floor(Date.now() / 1000) + 300;

  const query = Object.keys(params).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  try {
    const data = JSON.parse(UrlFetchApp.fetch(`https://maps.googleapis.com/maps/api/directions/json?${query}`, { muteHttpExceptions: true }).getContentText());
    if (data.status !== 'OK' || !data.routes?.length) {
      logW('getDirectionsDuration_: error', { mode, status: data.status });
      return null;
    }
    const totalMs = data.routes[0].legs.reduce((s, l) => s + (l.duration?.value || 0), 0) * 1000;
    cache.put(cacheKey, String(totalMs), 3600);
    logI('getDirectionsDuration_: ok', { mode, from: shortPlace_(origin), to: shortPlace_(destination), min: Math.round(totalMs / 60000) });
    return totalMs;
  } catch (e) { logE('getDirectionsDuration_: fetch error', { error: e.message }); return null; }
}

// ===================== TRAVEL BLOCK CRUD =====================

const TRAVEL_BLOCK_PREFIX = 'Travel';

function isTravelBlock_(ev) {
  if (ev.extendedProperties?.private?.travelForEventId) return true;
  if (ev.summary?.startsWith(TRAVEL_BLOCK_PREFIX)) return true;
  return false;
}

/**
 * Create or update a travel block. Uses full-day window to find existing block (prevents duplicates).
 */
function upsertTravelBlock_(calId, forEventId, start, end, origin, destination, mode, mapsUrl, dayWindowStart, dayWindowEnd) {
  const colorId = getProp_('TRAVEL_COLOR_ID', '8');
  const modeEmoji = mode === 'bicycling' ? '🚲' : '🚇';
  const durationMin = Math.round((end.getTime() - start.getTime()) / 60000);

  const summary = `${TRAVEL_BLOCK_PREFIX} ${modeEmoji} ${durationMin}min`;
  const description = [
    `${shortPlace_(origin)} → ${shortPlace_(destination)}`,
    `Mode: ${mode} | Duration: ${durationMin}min (incl. buffer)`,
    '', `📍 Itinerary: ${mapsUrl}`,
    '', `[Commute Blocker — ${forEventId}]`
  ].join('\n');

  const payload = {
    summary, description,
    start: { dateTime: start.toISOString() },
    end:   { dateTime: end.toISOString() },
    colorId, transparency: 'opaque',
    extendedProperties: { private: { travelForEventId: forEventId } }
  };

  // FIX: search full day window to find existing block (prevents duplicates)
  const existing = findTravelBlockFor_(calId, forEventId, dayWindowStart, dayWindowEnd);

  if (existing) {
    const needUpdate =
      Math.abs(new Date(existing.start.dateTime) - start) > minutes_(2) ||
      Math.abs(new Date(existing.end.dateTime) - end) > minutes_(2) ||
      existing.summary !== summary;
    if (needUpdate) {
      Calendar.Events.patch(payload, calId, existing.id);
      logI('upsertTravelBlock_: updated', { forEventId, blockId: existing.id, summary });
    }
  } else {
    // Before creating, double-check for any other blocks with same forEventId (dedup safety net)
    dedupTravelBlocks_(calId, forEventId, dayWindowStart, dayWindowEnd);
    const inserted = Calendar.Events.insert(payload, calId);
    logI('upsertTravelBlock_: created', { forEventId, blockId: inserted.id, summary });
  }
}

/**
 * Find our travel block for a specific event ID.
 * Uses privateExtendedProperty filter for fast, server-side lookup (no client-side scan).
 */
function findTravelBlockFor_(calId, forEventId, windowStart, windowEnd) {
  try {
    const list = Calendar.Events.list(calId, {
      timeMin: windowStart.toISOString(), timeMax: windowEnd.toISOString(),
      singleEvents: true, maxResults: 10,
      privateExtendedProperty: `travelForEventId=${forEventId}`
    });
    const items = list.items || [];
    if (items.length > 0) return items[0];
  } catch (e) { logW('findTravelBlockFor_: error', { error: e.message }); }
  return null;
}

/**
 * Remove ALL travel blocks for a specific event ID (handles duplicates).
 */
function removeTravelBlockFor_(calId, forEventId, windowStart, windowEnd) {
  try {
    const list = Calendar.Events.list(calId, {
      timeMin: windowStart.toISOString(), timeMax: windowEnd.toISOString(),
      singleEvents: true, maxResults: 50,
      privateExtendedProperty: `travelForEventId=${forEventId}`
    });
    let deleted = 0;
    for (const it of (list.items || [])) {
      Calendar.Events.remove(calId, it.id);
      deleted++;
    }
    if (deleted > 0) logI('removeTravelBlockFor_: removed', { forEventId, count: deleted });
    return deleted;
  } catch (e) { logW('removeTravelBlockFor_: error', { error: e.message }); return 0; }
}

/**
 * Dedup: remove extra travel blocks for the same forEventId (keeps none — caller will create fresh).
 */
function dedupTravelBlocks_(calId, forEventId, windowStart, windowEnd) {
  try {
    const list = Calendar.Events.list(calId, {
      timeMin: windowStart.toISOString(), timeMax: windowEnd.toISOString(),
      singleEvents: true, maxResults: 50,
      privateExtendedProperty: `travelForEventId=${forEventId}`
    });
    const dupes = list.items || [];
    if (dupes.length > 0) {
      logW('dedupTravelBlocks_: cleaning', { forEventId, count: dupes.length });
      for (const d of dupes) {
        try { Calendar.Events.remove(calId, d.id); } catch (e) {}
      }
    }
  } catch (e) { logW('dedupTravelBlocks_: error', { error: e.message }); }
}

// ===================== CONFLICT DETECTION =====================

function findOverlaps_(start, end, events, excludeEventId) {
  const startMs = start.getTime(), endMs = end.getTime();
  return events.filter(ev => {
    if (ev.id === excludeEventId || isTravelBlock_(ev)) return false;
    if (!ev.start?.dateTime || !ev.end?.dateTime) return false;
    const evStart = new Date(ev.start.dateTime).getTime();
    const evEnd = new Date(ev.end.dateTime).getTime();
    return startMs < evEnd && endMs > evStart;
  });
}

// ===================== CONFLICT EMAIL =====================

function sendConflictEmail_(conflicts, date) {
  const alertEmail = getProp_('ALERT_EMAIL');
  if (!alertEmail) return;

  const dateStr = date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  let body = `Commute Blocker: ${conflicts.length} conflit(s) non résolu(s) pour ${dateStr}.\n`;
  body += `(Les chevauchements avec visios/time blocks ont été résolus automatiquement.)\n\n`;

  for (const c of conflicts) {
    const fmt = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    body += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    body += `🗓 "${c.meeting}" à ${fmt(c.meetingStart)}\n`;
    body += `🚏 ${c.origin} → ${c.destination} (${c.travelMode})\n`;
    body += `⏰ Trajet: ${fmt(c.travelStart)} – ${fmt(c.travelEnd)}\n`;
    body += `⚠️ Chevauche:\n`;
    for (const o of c.overlaps) {
      body += `  • "${o.summary}" (${fmt(o.start)}–${fmt(o.end)})\n`;
    }
    body += `💡 À ajuster manuellement.\n\n`;
  }

  try {
    MailApp.sendEmail({ to: alertEmail, subject: `⚠️ Conflits trajet — ${dateStr}`, body });
    logI('sendConflictEmail_: sent', { conflicts: conflicts.length });
  } catch (e) { logE('sendConflictEmail_: failed', { error: e.message }); }
}
