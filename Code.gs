/** ------------------------------------------------------------
 * Auto Commute Blocker for Google Calendar — V5
 *
 * Creates "Travel" time blocks before/after meetings with physical locations.
 * Chains meetings (origin = previous meeting location, not always home).
 * Cycling in Paris (<45min), transit otherwise.
 * Auto-shifts travel before virtual meetings when overlap detected.
 * Intra-day returns: if gap between meetings allows round-trip home, adds return.
 *
 * V5 changes:
 *   - All-day multi-day events with a location are treated as hotel anchors.
 *   - "First-day exception": on the day a multi-day all-day hotel event STARTS,
 *     hotel is NOT yet anchor — you woke up at home. It only becomes anchor
 *     after a transit event fires that day.
 *   - Transit events generate ARRIVAL travel (anchor → departure station)
 *     and DEPARTURE travel (arrival station → home/hotel) when applicable.
 *   - Per-keyword platform buffers (Train: 10min, Flight: 90min, etc.).
 *   - getActiveHotelAt_ / getActiveHotelAfter_ helpers replace day-wide
 *     findHotelNight_ for time-aware anchor resolution.
 *   - Bug fixes from V4:
 *     - _depart block now uses departMode.durationMs (was arriveMode, undefined).
 *     - dateStr falls back to all-day events when no timed event present.
 *
 * Based on Auto Drive-Time Blocker by Mathew Varghese (MIT License).
 *
 * SCRIPT PROPERTIES (Project Settings → Script properties):
 *   HOME_ADDRESS           -> "Your home address"
 *   OFFICE_ADDRESS         -> "" (optional — set to office address for Workspace users)
 *   BUFFER_MINUTES         -> "10"
 *   WATCH_CALENDAR_ID      -> "primary"
 *   GOOGLE_MAPS_API_KEY    -> Directions API key
 *   POLL_INTERVAL_MINUTES  -> "30"
 *   DAY_START_HOUR         -> "9"
 *   FIRST_MEETING_WINDOW   -> "90"
 *   CHAIN_WINDOW_MINUTES   -> "120"
 *   NEXT_MEETING_WINDOW    -> "90"
 *   CYCLING_MAX_MINUTES    -> "45"
 *   EVENING_CUTOFF_HOUR    -> "17"
 *   ALERT_EMAIL            -> "your@email.com"
 *   LOG_LEVEL              -> "INFO"
 *   TRAVEL_COLOR_ID        -> "8"
 *   TRANSIT_KEYWORDS       -> "Train,Flight,TGV,Vol" (title prefixes; default if unset)
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

/**
 * Paginated Calendar.Events.list — accumulates all pages so a busy day with
 * >250 events doesn't silently truncate. Returns the items array.
 */
function listAllEventsInWindow_(calId, timeMin, timeMax, extraOpts) {
  const items = [];
  let pageToken;
  do {
    const resp = Calendar.Events.list(calId, Object.assign({
      timeMin: timeMin, timeMax: timeMax,
      singleEvents: true, maxResults: 250,
      orderBy: 'startTime', pageToken: pageToken,
    }, extraOpts || {}));
    if (resp.items) items.push(...resp.items);
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return items;
}

/** Find all travel blocks in `events` that match a given forEventId. */
function findBlockInList_(events, forEventId) {
  return (events || []).filter(ev =>
    ev.extendedProperties?.private?.travelForEventId === forEventId
  );
}

/** Remove an event by id from a working dayEvents array (mutates). */
function consumeBlock_(events, blockId) {
  const i = events.findIndex(ev => ev.id === blockId);
  if (i >= 0) events.splice(i, 1);
}

function hasPhysicalLocation_(ev) {
  const loc = (ev.location || '').trim();
  if (!loc) return false;
  if (/^https?:\/\//i.test(loc)) return false;
  if (/^(meet\.google|zoom\.us|teams\.microsoft)/i.test(loc)) return false;
  // Catch French/English virtual-meeting labels (no URL form)
  if (/(microsoft\s*teams|google\s*meet|zoom\b|réunion|webex|webcall)/i.test(loc)) return false;
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

// ----- Transit detection -----

const DEFAULT_TRANSIT_KEYWORDS = ['Train', 'Flight', 'TGV', 'Vol'];

function getTransitKeywords_() {
  const raw = getProp_('TRANSIT_KEYWORDS', '');
  if (!raw) return DEFAULT_TRANSIT_KEYWORDS;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Per-keyword platform buffer in minutes (added on top of global BUFFER_MINUTES).
 * TODO: make configurable via TRANSIT_PLATFORM_BUFFERS script property if needed.
 */
const TRANSIT_PLATFORM_BUFFERS = {
  Train: 10,
  TGV: 10,
  Flight: 90,
  Vol: 90,
};

function getTransitPlatformBuffer_(ev) {
  const title = (ev.summary || '').trim();
  for (const kw of Object.keys(TRANSIT_PLATFORM_BUFFERS)) {
    const re = new RegExp(`^${kw}\\s+to\\s+`, 'i');
    if (re.test(title)) return TRANSIT_PLATFORM_BUFFERS[kw];
  }
  return 10;
}

function isTransitEvent_(ev) {
  if (isTravelBlock_(ev)) return false;
  const title = (ev.summary || '').trim();
  if (!title) return false;
  const keywords = getTransitKeywords_();
  for (const kw of keywords) {
    const re = new RegExp(`^${kw}\\s+to\\s+`, 'i');
    if (re.test(title)) return true;
  }
  return false;
}

function parseTransitDestination_(ev) {
  const title = (ev.summary || '').trim();
  const keywords = getTransitKeywords_();
  for (const kw of keywords) {
    const re = new RegExp(`^${kw}\\s+to\\s+(.+)$`, 'i');
    const m = title.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

// ----- Hotel detection -----

/**
 * True if an event is a multi-day stay (hotel night) — used as anchor only,
 * never gets travel blocks generated for it. Two formats supported:
 *   - Timed event spanning overnight (e.g. 22:30 → 09:30 next day)
 *   - All-day event spanning multiple calendar days ("Stay at X")
 */
function isHotelNightEvent_(ev) {
  if (!hasPhysicalLocation_(ev)) return false;

  if (ev.start?.dateTime && ev.end?.dateTime) {
    const startDate = new Date(ev.start.dateTime).toISOString().substring(0, 10);
    const endDate = new Date(ev.end.dateTime).toISOString().substring(0, 10);
    return endDate > startDate;
  }

  if (ev.start?.date && ev.end?.date) {
    const startMs = new Date(ev.start.date + 'T00:00:00').getTime();
    const endMs = new Date(ev.end.date + 'T00:00:00').getTime();
    return endMs - startMs >= 2 * 24 * 60 * 60 * 1000;
  }

  return false;
}

/**
 * Returns hotel address if targetTime is "inside" an active hotel-trip span.
 *
 * First-day exception: on the day a multi-day all-day hotel event STARTS,
 * hotel is NOT yet anchor — you woke up at home. It only becomes anchor after
 * a transit event fires that day.
 *
 * For timed overnight events (22:30 → 09:30), targetTime must be ≥ start time.
 */
function getActiveHotelAt_(dayEvents, targetTime) {
  const targetMs = targetTime.getTime();
  let mostRecent = null;
  let mostRecentStartMs = 0;

  for (const ev of dayEvents) {
    if (!isHotelNightEvent_(ev)) continue;

    let startMs, endMs, isFirstDay;
    if (ev.start.dateTime) {
      startMs = new Date(ev.start.dateTime).getTime();
      endMs = new Date(ev.end.dateTime).getTime();
      if (targetMs < startMs) continue;
      isFirstDay = false;
    } else {
      startMs = new Date(ev.start.date + 'T00:00:00').getTime();
      endMs = new Date(ev.end.date + 'T00:00:00').getTime();
      if (targetMs < startMs || targetMs >= endMs) continue;
      const targetDate = new Date(targetMs).toISOString().substring(0, 10);
      isFirstDay = (targetDate === ev.start.date);
    }

    if (isFirstDay) {
      // First day: only active if a transit event has already fired today
      const dayStart = new Date(targetMs);
      dayStart.setHours(0, 0, 0, 0);
      const dayStartMs = dayStart.getTime();
      const transitFiredToday = dayEvents.some(other => {
        if (!isTransitEvent_(other)) return false;
        if (!other.end?.dateTime) return false;
        const otherEndMs = new Date(other.end.dateTime).getTime();
        return otherEndMs >= dayStartMs && otherEndMs <= targetMs;
      });
      if (!transitFiredToday) continue;
    }

    if (startMs > mostRecentStartMs) {
      mostRecent = ev;
      mostRecentStartMs = startMs;
    }
  }

  return mostRecent ? mostRecent.location.trim() : null;
}

/**
 * Returns hotel address for a hotel-trip that starts AFTER afterTime.
 * Used to find "where am I sleeping tonight" after a meeting or transit ends.
 */
function getActiveHotelAfter_(dayEvents, afterTime) {
  const afterMs = afterTime.getTime();
  for (const ev of dayEvents) {
    if (!isHotelNightEvent_(ev)) continue;
    let startMs;
    if (ev.start.dateTime) {
      startMs = new Date(ev.start.dateTime).getTime();
    } else {
      startMs = new Date(ev.start.date + 'T00:00:00').getTime();
    }
    if (startMs >= afterMs) return ev.location.trim();
  }
  return null;
}

// ----- Misc helpers -----

function shortPlace_(loc) {
  return (loc || '').split(',')[0].trim() || loc || 'destination';
}
function mapsUrl_(origin, destination, mode) {
  const base = 'https://www.google.com/maps/dir/?api=1';
  return `${base}&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=${mode === 'bicycling' ? 'bicycling' : 'transit'}`;
}
function normalizeAddr_(addr) {
  return (addr || '').toLowerCase().trim().replace(/,?\s*france\s*$/i, '').replace(/\s+/g, ' ').trim();
}
function sameLocation_(a, b) {
  return normalizeAddr_(a) === normalizeAddr_(b);
}

/**
 * Get the home/office anchor for a specific date/time using Workspace working location.
 */
function getAnchorForTime_(calId, dateTime) {
  const home = getProp_('HOME_ADDRESS');
  const office = getProp_('OFFICE_ADDRESS', '');
  if (!office) return home;

  const dateStr = dateTime.toISOString().substring(0, 10);
  const cache = CacheService.getScriptCache();
  const cacheKey = `anchor|${dateStr}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached === 'office' ? office : home;

  try {
    const dayStart = new Date(dateStr + 'T00:00:00');
    const dayEnd = new Date(dayStart.getTime() + hours_(24));
    const resp = Calendar.Events.list(calId, {
      timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(),
      singleEvents: true, eventTypes: ['workingLocation'], maxResults: 10, orderBy: 'startTime'
    });
    const wlEvents = resp.items || [];
    if (wlEvents.length === 0) {
      cache.put(cacheKey, 'home', 3600);
      return home;
    }
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
            cache.put(cacheKey, 'office', 3600);
            return office;
          }
          if (wlProps.homeOffice !== undefined) {
            cache.put(cacheKey, 'home', 3600);
            return home;
          }
        }
      }
    }
    cache.put(cacheKey, 'home', 3600);
    return home;
  } catch (e) {
    logD('getAnchorForTime_: working location not available, using home', { error: e.message });
    cache.put(cacheKey, 'home', 3600);
    return home;
  }
}

/**
 * Resolve the user's location at a given moment.
 *
 * Priority:
 *   1. Most recent transit event ended before targetTime → its destination
 *   2. Active hotel covering targetTime → hotel address
 *   3. Workspace working location → home or office
 *
 * Transit takes precedence over hotel: if you took a train somewhere AND have
 * a hotel night, the most recent transit destination wins until you transit again.
 */
function resolveTimelineAnchor_(calId, dayEvents, targetTime) {
  const targetMs = targetTime.getTime();

  let mostRecentTransit = null;
  for (const ev of dayEvents) {
    if (!isTransitEvent_(ev)) continue;
    if (!ev.end?.dateTime) continue;
    const endMs = new Date(ev.end.dateTime).getTime();
    if (endMs > targetMs) continue;
    if (!mostRecentTransit || endMs > new Date(mostRecentTransit.end.dateTime).getTime()) {
      mostRecentTransit = ev;
    }
  }

  if (mostRecentTransit) {
    const dest = parseTransitDestination_(mostRecentTransit);
    if (dest) {
      logD('resolveTimelineAnchor_: using transit destination', { dest });
      return dest;
    }
  }

  const activeHotel = getActiveHotelAt_(dayEvents, targetTime);
  if (activeHotel) {
    logD('resolveTimelineAnchor_: using hotel anchor', { hotel: shortPlace_(activeHotel) });
    return activeHotel;
  }

  return getAnchorForTime_(calId, targetTime);
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
    const sync = getChangedDates_();
    if (sync.selfOnly) {
      logD('onCalChange_: self-trigger guard, skipping', { count: sync.totalChanged });
      return;
    }
    const changedDates = sync.dates;
    if (changedDates.length === 0) {
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

function getChangedDates_() {
  const calId = getProp_('WATCH_CALENDAR_ID', 'primary');
  const props = PropertiesService.getUserProperties();
  const syncToken = props.getProperty('SYNC_TOKEN');
  const dates = new Set();
  let totalChanged = 0;
  let nonSelfChanged = 0;

  try {
    let resp;
    if (syncToken) {
      try {
        resp = Calendar.Events.list(calId, { syncToken: syncToken });
      } catch (e) {
        logI('getChangedDates_: sync token expired, reinitializing');
        initSyncToken_();
        return { dates: [], selfOnly: false, totalChanged: 0 };
      }
    } else {
      initSyncToken_();
      return { dates: [], selfOnly: false, totalChanged: 0 };
    }

    const items = resp.items || [];
    totalChanged = items.length;
    for (const ev of items) {
      // Skip cancelled events entirely — they often arrive without summary or
      // extendedProperties, so isTravelBlock_ can't classify them. Counting
      // them as "non-self" causes the self-trigger guard to fail when our
      // own writes cascade through (delete+reinsert during dedup, etc).
      if (ev.status === 'cancelled') continue;
      if (isTravelBlock_(ev)) continue;
      nonSelfChanged++;
      const dt = ev.start?.dateTime || ev.start?.date;
      if (dt) dates.add(dt.substring(0, 10));
      const odt = ev.originalStartTime?.dateTime || ev.originalStartTime?.date;
      if (odt) dates.add(odt.substring(0, 10));
    }

    if (resp.nextSyncToken) {
      props.setProperty('SYNC_TOKEN', resp.nextSyncToken);
    }
  } catch (e) {
    logW('getChangedDates_: error', { error: e.message });
  }

  const selfOnly = totalChanged > 0 && nonSelfChanged === 0;
  return { dates: Array.from(dates), selfOnly, totalChanged };
}

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

function processSingleDay_(dateStr) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    logW('processSingleDay_: lock timeout, skipping', { date: dateStr });
    return;
  }

  const calId = getProp_('WATCH_CALENDAR_ID', 'primary');
  const dayStart = new Date(dateStr + 'T00:00:00');
  const dayEnd = new Date(dayStart.getTime() + hours_(24));

  try {
    const events = listAllEventsInWindow_(calId, dayStart.toISOString(), dayEnd.toISOString());
    logI('processSingleDay_: fetched', { date: dateStr, count: events.length });
    processDayChain_(calId, events, false, dateStr);
  } catch (e) {
    logE('processSingleDay_: error', { date: dateStr, error: e.message });
  } finally {
    lock.releaseLock();
  }
}

function scanDays_(days) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    logW('scanDays_: lock timeout, skipping', { days });
    return;
  }

  const t0 = Date.now();
  const calId = getProp_('WATCH_CALENDAR_ID', 'primary');
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const maxT = new Date(dayStart.getTime() + hours_(days * 24));

  try {
    // For each day in window, fetch events that touch that day and process.
    // Per-day fetch ensures multi-day events (hotels) are visible to the day
    // they overlap — they wouldn't be if we just grouped by start.dateTime.
    for (let i = 0; i < days; i++) {
      const t = new Date(dayStart.getTime() + hours_(i * 24));
      const dateStr = t.toISOString().substring(0, 10);
      const dEnd = new Date(t.getTime() + hours_(24));
      try {
        const events = listAllEventsInWindow_(calId, t.toISOString(), dEnd.toISOString());
        processDayChain_(calId, events, false, dateStr);
      } catch (e) {
        logE('scanDays_: chain error', { date: dateStr, error: e.message });
      }
    }
  } finally {
    lock.releaseLock();
  }
  logI('scanDays_: done', { days, durationMs: durMs_(t0) });
}

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
  const dateStr = dayStart.toISOString().substring(0, 10);

  try {
    const events = listAllEventsInWindow_(calId, dayStart.toISOString(), dayEnd.toISOString());
    const conflicts = processDayChain_(calId, events, true, dateStr);
    if (conflicts && conflicts.length > 0) sendConflictEmail_(conflicts, now);
    else logI('morningSweep_: no conflicts');
  } catch (e) {
    logE('morningSweep_: error', { error: e.message });
  }
  logI('morningSweep_: done', { durationMs: durMs_(t0) });
}

function scanNow() { console.log('scanNow()'); scanUpcoming_(); }
function sweepNow() { console.log('sweepNow()'); morningSweep_(); }

// ===================== CLEANUP UTILITIES =====================

/**
 * EMERGENCY CLEANUP — remove duplicate travel blocks.
 * Run from the Apps Script editor.
 */
function emergencyCleanupTravelDuplicates() {
  const calId = getProp_('WATCH_CALENDAR_ID', 'primary');
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(start.getTime() + hours_(60 * 24));

  const allTravelBlocks = [];
  let pageToken;
  do {
    const resp = Calendar.Events.list(calId, {
      timeMin: start.toISOString(), timeMax: end.toISOString(),
      singleEvents: true, maxResults: 250, pageToken: pageToken,
    });
    for (const ev of (resp.items || [])) {
      if (isTravelBlock_(ev)) allTravelBlocks.push(ev);
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);

  logI('emergencyCleanup: scanned', { total: allTravelBlocks.length });

  const groups = {};
  const orphanGroups = {};
  for (const b of allTravelBlocks) {
    const forId = b.extendedProperties?.private?.travelForEventId;
    if (forId) {
      if (!groups[forId]) groups[forId] = [];
      groups[forId].push(b);
    } else {
      const key = `${b.start?.dateTime}|${b.summary}`;
      if (!orphanGroups[key]) orphanGroups[key] = [];
      orphanGroups[key].push(b);
    }
  }

  let removed = 0;
  let rateLimitHit = false;
  const purgeGroup = (blocks) => {
    if (rateLimitHit || blocks.length <= 1) return;
    blocks.sort((a, b) => new Date(a.created) - new Date(b.created));
    for (let i = 1; i < blocks.length; i++) {
      if (rateLimitHit) return;
      try {
        Calendar.Events.remove(calId, blocks[i].id);
        removed++;
        Utilities.sleep(250);
      } catch (e) {
        if (/rate.?limit/i.test(e.message)) {
          logW('emergencyCleanup: rate limit hit, stopping', { removedSoFar: removed });
          rateLimitHit = true;
          return;
        }
        logW('emergencyCleanup: remove failed', { id: blocks[i].id, error: e.message });
      }
    }
  };
  Object.values(groups).forEach(purgeGroup);
  Object.values(orphanGroups).forEach(purgeGroup);

  logI('emergencyCleanup: done', { removed, kept: allTravelBlocks.length - removed });
  console.log(`Removed ${removed} duplicate travel blocks. Kept ${allTravelBlocks.length - removed}.`);
}

function startBackgroundCleanup() {
  stopBackgroundCleanup();
  ScriptApp.newTrigger('cleanupTick_').timeBased().everyMinutes(10).create();
  console.log('Background cleanup started. Trigger fires every 10 min. Run stopBackgroundCleanup() to halt.');
  cleanupTick_();
}

function stopBackgroundCleanup() {
  let removed = 0;
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'cleanupTick_') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  }
  if (removed > 0) console.log(`Stopped background cleanup (${removed} trigger(s) removed).`);
  else console.log('No background cleanup trigger was running.');
}

function cleanupTick_() {
  const MAX_DELETES_PER_RUN = 50;
  const SLEEP_MS = 1100;

  const calId = getProp_('WATCH_CALENDAR_ID', 'primary');
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(start.getTime() + hours_(60 * 24));

  const allTravelBlocks = [];
  let pageToken;
  do {
    const resp = Calendar.Events.list(calId, {
      timeMin: start.toISOString(), timeMax: end.toISOString(),
      singleEvents: true, maxResults: 250, pageToken: pageToken,
    });
    for (const ev of (resp.items || [])) {
      if (isTravelBlock_(ev)) allTravelBlocks.push(ev);
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);

  const groups = {};
  const orphanGroups = {};
  for (const b of allTravelBlocks) {
    const forId = b.extendedProperties?.private?.travelForEventId;
    if (forId) {
      if (!groups[forId]) groups[forId] = [];
      groups[forId].push(b);
    } else {
      const key = `${b.start?.dateTime}|${b.summary}`;
      if (!orphanGroups[key]) orphanGroups[key] = [];
      orphanGroups[key].push(b);
    }
  }

  const toDelete = [];
  const collectDuplicates = (groupMap) => {
    for (const blocks of Object.values(groupMap)) {
      if (blocks.length <= 1) continue;
      blocks.sort((a, b) => new Date(a.created) - new Date(b.created));
      for (let i = 1; i < blocks.length; i++) toDelete.push(blocks[i]);
    }
  };
  collectDuplicates(groups);
  collectDuplicates(orphanGroups);

  logI('cleanupTick_: status', { totalBlocks: allTravelBlocks.length, duplicatesRemaining: toDelete.length });

  if (toDelete.length === 0) {
    stopBackgroundCleanup();
    console.log(`✅ Cleanup complete. ${allTravelBlocks.length} travel blocks remain (no duplicates).`);
    return;
  }

  let removed = 0;
  for (let i = 0; i < Math.min(MAX_DELETES_PER_RUN, toDelete.length); i++) {
    try {
      Calendar.Events.remove(calId, toDelete[i].id);
      removed++;
      Utilities.sleep(SLEEP_MS);
    } catch (e) {
      if (/rate.?limit/i.test(e.message)) {
        logW('cleanupTick_: rate limit hit, will retry next tick', { removedThisRun: removed });
        break;
      }
      logW('cleanupTick_: remove failed', { id: toDelete[i].id, error: e.message });
    }
  }

  console.log(`Removed ${removed} this run. ~${toDelete.length - removed} duplicates still remaining.`);
}

// ===================== CORE CHAIN LOGIC =====================

/**
 * Process a single day's events as an ordered chain.
 *
 * dateStr is required (passed by callers). Used for window bounds and
 * (indirectly) for hotel detection.
 */
function processDayChain_(calId, dayEvents, isMorningSweep, dateStr) {
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

  // Filter: timed, accepted events for the meeting loop
  const timedEvents = dayEvents.filter(ev => ev.start?.dateTime && isAccepted_(ev));

  // Classify
  const physicalMeetings = [];
  const existingTravelBlocks = [];
  const virtualMeetings = [];
  const userTimeBlocks = [];
  const transitEvents = [];
  const otherEvents = [];

  for (const ev of timedEvents) {
    if (isTravelBlock_(ev)) existingTravelBlocks.push(ev);
    else if (isTransitEvent_(ev)) transitEvents.push(ev);
    else if (isUserTimeBlock_(ev)) userTimeBlocks.push(ev);
    else if (isHotelNightEvent_(ev)) { /* anchor-only via dayEvents, no travel block */ }
    else if (hasPhysicalLocation_(ev)) physicalMeetings.push(ev);
    else virtualMeetings.push(ev);
  }

  physicalMeetings.sort((a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));
  const allNonTravelEvents = [...physicalMeetings, ...virtualMeetings, ...userTimeBlocks, ...transitEvents, ...otherEvents];

  logD('processDayChain_: classified', {
    date: dateStr,
    physical: physicalMeetings.length,
    virtual: virtualMeetings.length,
    transit: transitEvents.length,
    timeBlocks: userTimeBlocks.length,
    travel: existingTravelBlocks.length
  });

  const neededTravelBlockIds = new Set();
  const conflicts = [];

  // ---- MEETING LOOP ----
  for (let i = 0; i < physicalMeetings.length; i++) {
    const meeting = physicalMeetings[i];
    const meetingStart = new Date(meeting.start.dateTime);
    const meetingEnd = new Date(meeting.end.dateTime);
    const destination = meeting.location.trim();

    // ---- RESOLVE ORIGIN ----
    const anchor = resolveTimelineAnchor_(calId, dayEvents, meetingStart);
    let origin = anchor;
    if (i > 0) {
      const prevMeeting = physicalMeetings[i - 1];
      const prevEnd = new Date(prevMeeting.end.dateTime);
      const gap = meetingStart.getTime() - prevEnd.getTime();

      if (gap <= minutes_(nextMeetingWindow)) {
        origin = prevMeeting.location.trim();
      } else if (gap <= minutes_(chainWindow)) {
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
    }

    // First meeting within window of day start → home (just woke up).
    // BUT: if hotel/transit anchor is active, keep that.
    if (i === 0 && sameLocation_(anchor, home)) {
      const dayDate = new Date(meeting.start.dateTime);
      const dayStartTime = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), dayStartHour, 0, 0);
      if (meetingStart.getTime() - dayStartTime.getTime() <= minutes_(firstMeetingWindow)) {
        origin = home;
      }
    }

    // Skip if same location or destination is the anchor
    if (sameLocation_(origin, destination) || sameLocation_(destination, anchor)) {
      removeTravelBlockFor_(calId, meeting.id, dayEvents);
      continue;
    }

    // ---- COMPUTE TRAVEL ----
    const modeResult = determineTravelMode_(origin, destination, apiKey);
    if (!modeResult) { logW('processDayChain_: no mode', { meetingId: meeting.id }); continue; }

    const totalMs = modeResult.durationMs + minutes_(bufferMin);
    let travelEnd = meetingStart;
    let travelStart = new Date(travelEnd.getTime() - totalMs);

    const resolution = resolveOverlaps_(travelStart, travelEnd, allNonTravelEvents, meeting.id, calId, 0);
    travelStart = resolution.travelStart;
    travelEnd = resolution.travelEnd;

    neededTravelBlockIds.add(meeting.id);
    upsertTravelBlock_(calId, meeting.id, travelStart, travelEnd, origin, destination, modeResult.mode, mapsUrl_(origin, destination, modeResult.mode), dayEvents);

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
    let returnAnchor;
    if (meetingEnd.getHours() >= eveningCutoff) {
      // Evening: prefer active hotel, else home
      returnAnchor = getActiveHotelAt_(dayEvents, meetingEnd) || home;
    } else {
      returnAnchor = resolveTimelineAnchor_(calId, dayEvents, meetingEnd);
    }

    if (!sameLocation_(destination, returnAnchor)) {
      let shouldCreateReturn = false;
      const returnId = meeting.id + '_return';

      if (!nextPhysical) {
        shouldCreateReturn = true;
      } else {
        const nextStart = new Date(nextPhysical.start.dateTime);
        const gap = nextStart.getTime() - meetingEnd.getTime();

        if (gap > minutes_(nextMeetingWindow)) {
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
      }

      if (shouldCreateReturn) {
        if (!sameLocation_(destination, returnAnchor)) {
          const retMode = determineTravelMode_(destination, returnAnchor, apiKey);
          if (retMode) {
            const retTotalMs = retMode.durationMs + minutes_(bufferMin);
            const retStart = meetingEnd;
            const retEnd = new Date(retStart.getTime() + retTotalMs);
            upsertTravelBlock_(calId, returnId, retStart, retEnd, destination, returnAnchor, retMode.mode, mapsUrl_(destination, returnAnchor, retMode.mode), dayEvents);
            neededTravelBlockIds.add(returnId);
          }
        }
      } else {
        removeTravelBlockFor_(calId, returnId, dayEvents);
      }
    }
  }

  // ---- TRANSIT EVENT TRAVEL: arrival/departure ----
  transitEvents.sort((a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));
  for (const transit of transitEvents) {
    const transitStart = new Date(transit.start.dateTime);
    const transitEnd = new Date(transit.end.dateTime);
    const departureStation = (transit.location || '').trim();
    const arrivalStation = parseTransitDestination_(transit);

    // ARRIVAL TRAVEL: anchor → departure station, ending at transit start
    if (departureStation) {
      const arriveAnchor = resolveTimelineAnchor_(calId, dayEvents, transitStart);
      if (!sameLocation_(arriveAnchor, departureStation)) {
        const arriveMode = determineTravelMode_(arriveAnchor, departureStation, apiKey);
        if (arriveMode) {
          const platformBuffer = getTransitPlatformBuffer_(transit);
          const totalMs = arriveMode.durationMs + minutes_(bufferMin) + minutes_(platformBuffer);
          const blockEnd = transitStart;
          const blockStart = new Date(blockEnd.getTime() - totalMs);
          const arriveId = transit.id + '_arrive';
          upsertTravelBlock_(calId, arriveId, blockStart, blockEnd, arriveAnchor, departureStation,
            arriveMode.mode, mapsUrl_(arriveAnchor, departureStation, arriveMode.mode), dayEvents);
          neededTravelBlockIds.add(arriveId);
        }
      }
    }

    // DEPARTURE TRAVEL: arrival station → home/hotel, starting at transit end.
    // Only if NO physical meeting follows on the same day (otherwise that meeting's
    // travel block already handles the exit via timeline anchor).
    if (arrivalStation) {
      const transitEndMs = transitEnd.getTime();
      const hasFollowupMeeting = physicalMeetings.some(m =>
        new Date(m.start.dateTime).getTime() >= transitEndMs);

      if (!hasFollowupMeeting) {
        // Future hotel after this transit takes precedence over home
        const departTarget = getActiveHotelAfter_(dayEvents, transitEnd) || home;
        if (!sameLocation_(arrivalStation, departTarget)) {
          const departMode = determineTravelMode_(arrivalStation, departTarget, apiKey);
          if (departMode) {
            const totalMs = departMode.durationMs + minutes_(bufferMin);
            const blockStart = transitEnd;
            const blockEnd = new Date(blockStart.getTime() + totalMs);
            const departId = transit.id + '_depart';
            upsertTravelBlock_(calId, departId, blockStart, blockEnd, arrivalStation, departTarget,
              departMode.mode, mapsUrl_(arrivalStation, departTarget, departMode.mode), dayEvents);
            neededTravelBlockIds.add(departId);
          }
        }
      }
    }
  }

  // ---- ORPHAN CLEANUP ----
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
 * Upsert a travel block for forEventId using the in-memory dayEvents snapshot
 * as the source of truth — no second Calendar.Events.list call. dayEvents is
 * mutated to reflect inserts/patches/removes so subsequent iterations of the
 * chain loop see consistent state.
 */
function upsertTravelBlock_(calId, forEventId, start, end, origin, destination, mode, mapsUrl, dayEvents) {
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

  const matches = findBlockInList_(dayEvents, forEventId);

  if (matches.length > 1) {
    // Should not normally happen post-fix. Log loudly so regressions surface
    // with the trace data we lacked in the V5.3 cascade investigation.
    matches.sort((a, b) => new Date(a.created) - new Date(b.created));
    logW('upsertTravelBlock_: multiple matches in dayEvents — collapsing', {
      forEventId,
      count: matches.length,
      ids: matches.map(m => ({ id: m.id, created: m.created })),
    });
    for (let i = 1; i < matches.length; i++) {
      try { Calendar.Events.remove(calId, matches[i].id); }
      catch (e) { logW('upsertTravelBlock_: collapse remove failed', { id: matches[i].id, error: e.message }); }
      consumeBlock_(dayEvents, matches[i].id);
    }
  }

  if (matches.length === 0) {
    const inserted = Calendar.Events.insert(payload, calId);
    dayEvents.push(inserted);
    logI('upsertTravelBlock_: created', { forEventId, blockId: inserted.id, summary });
    return;
  }

  const existing = matches[0];
  const needUpdate =
    Math.abs(new Date(existing.start.dateTime) - start) > minutes_(2) ||
    Math.abs(new Date(existing.end.dateTime) - end) > minutes_(2) ||
    existing.summary !== summary;
  if (needUpdate) {
    const patched = Calendar.Events.patch(payload, calId, existing.id);
    Object.assign(existing, patched);
    logI('upsertTravelBlock_: updated', { forEventId, blockId: existing.id, summary });
  }
}

/**
 * Remove travel block(s) matching forEventId from both the calendar and the
 * in-memory dayEvents snapshot.
 */
function removeTravelBlockFor_(calId, forEventId, dayEvents) {
  const matches = findBlockInList_(dayEvents, forEventId);
  let deleted = 0;
  for (const m of matches) {
    try {
      Calendar.Events.remove(calId, m.id);
      consumeBlock_(dayEvents, m.id);
      deleted++;
    } catch (e) { logW('removeTravelBlockFor_: remove failed', { id: m.id, error: e.message }); }
  }
  if (deleted > 0) logI('removeTravelBlockFor_: removed', { forEventId, count: deleted });
  return deleted;
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

// ===================== DIAGNOSTICS =====================

/**
 * Log everything the script sees on a specific day. Edit DEBUG_DATE.
 */
function debugDay() {
  const DEBUG_DATE = '2026-05-09';
  const calId = getProp_('WATCH_CALENDAR_ID', 'primary');
  const dayStart = new Date(DEBUG_DATE + 'T00:00:00');
  const dayEnd = new Date(dayStart.getTime() + hours_(24));

  const resp = Calendar.Events.list(calId, {
    timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(),
    singleEvents: true, maxResults: 250, orderBy: 'startTime'
  });
  const events = resp.items || [];

  console.log(`=== Events on ${DEBUG_DATE}: ${events.length} ===`);
  for (const ev of events) {
    const start = (ev.start?.dateTime || ev.start?.date || '?').substring(0, 16);
    const end = (ev.end?.dateTime || ev.end?.date || '?').substring(0, 16);
    const title = ev.summary || '(no title)';
    const loc = ev.location || '(no location)';
    const transit = isTransitEvent_(ev);
    const dest = transit ? parseTransitDestination_(ev) : null;
    const isOurBlock = isTravelBlock_(ev);
    const isHotel = isHotelNightEvent_(ev);
    const forId = ev.extendedProperties?.private?.travelForEventId || '(none)';
    console.log(`  ${start} → ${end} | "${title}"`);
    console.log(`    loc="${loc}"`);
    console.log(`    transit=${transit}${dest ? ` (→${dest})` : ''} | hotel=${isHotel} | ourBlock=${isOurBlock} | forId=${forId}`);
  }
}

/**
 * Probes whether Calendar.Events.list reflects fresh inserts within seconds.
 * Run with triggers OFF. Inserts a temporary travel-block-shaped event, polls
 * list 5 times at 2s intervals, then removes the test event. If `found=true`
 * appears immediately, list is strongly consistent for fresh inserts; if it
 * lags, secondary list calls in the chain loop were exposed to that lag.
 */
function debugListConsistency() {
  const calId = getProp_('WATCH_CALENDAR_ID', 'primary');
  const testForId = 'consistency_test_' + Date.now();
  const start = new Date(Date.now() + 10 * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const dayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + hours_(36));

  const inserted = Calendar.Events.insert({
    summary: 'Travel test consistency',
    start: { dateTime: start.toISOString() },
    end:   { dateTime: end.toISOString() },
    extendedProperties: { private: { travelForEventId: testForId } }
  }, calId);
  console.log(`Inserted: ${inserted.id}`);

  for (let i = 0; i < 5; i++) {
    const list = Calendar.Events.list(calId, {
      timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(),
      singleEvents: true, maxResults: 250
    });
    const found = (list.items || []).find(ev => ev.id === inserted.id);
    console.log(`Attempt ${i + 1} at +${i * 2}s: found=${!!found}, totalItems=${(list.items || []).length}`);
    Utilities.sleep(2000);
  }

  Calendar.Events.remove(calId, inserted.id);
  console.log('Test block removed.');
}
