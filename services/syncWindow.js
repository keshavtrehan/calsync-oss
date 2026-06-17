const PAST_WINDOW_DAYS = 7;
const FUTURE_WINDOW_YEARS = 1;

function getSyncWindow(now = new Date()) {
  const timeMin = new Date(now);
  timeMin.setDate(timeMin.getDate() - PAST_WINDOW_DAYS);

  const timeMax = new Date(now);
  timeMax.setFullYear(timeMax.getFullYear() + FUTURE_WINDOW_YEARS);

  return { timeMin, timeMax };
}

function getEventStartDate(event) {
  const rawStart = event.start?.dateTime ?? event.start?.date;
  return rawStart ? new Date(rawStart) : null;
}

function isEventInSyncWindow(event, now = new Date()) {
  const start = getEventStartDate(event);
  if (!start || Number.isNaN(start.getTime())) return false;

  const { timeMin, timeMax } = getSyncWindow(now);
  return start >= timeMin && start <= timeMax;
}

function describeSyncWindow(now = new Date()) {
  const { timeMin, timeMax } = getSyncWindow(now);
  return {
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
  };
}

module.exports = {
  PAST_WINDOW_DAYS,
  FUTURE_WINDOW_YEARS,
  getSyncWindow,
  getEventStartDate,
  isEventInSyncWindow,
  describeSyncWindow,
};
