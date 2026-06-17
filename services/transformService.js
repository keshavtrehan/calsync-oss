const { logger } = require('./logger');

function transformEvent(sourceEvent, syncRule) {
  // --- Title ---
  const copyTitle = syncRule.copy_title !== false;
  const titlePrefix = syncRule.title_prefix ?? '';
  const titleSuffix = syncRule.title_suffix ?? '';

  if (!copyTitle && !titlePrefix.trim()) {
    throw new Error('title_prefix is required when copy_title is false');
  }

  const baseTitle = sourceEvent.summary ?? '';
  const title = copyTitle
    ? `${titlePrefix}${baseTitle}${titleSuffix}`
    : `${titlePrefix}${titleSuffix}`;

  // --- Description ---
  let description = undefined;
  if (syncRule.copy_description) {
    description = sourceEvent.description ?? '';
  }

  // --- Attendees (appended to description, never copied as actual attendees) ---
  if (syncRule.copy_attendees && sourceEvent.attendees?.length) {
    const emails = sourceEvent.attendees.map((a) => a.email).filter(Boolean).join(', ');
    if (emails) {
      const attendeeLine = `\n\n👥 Attendees: ${emails}`;
      description = (description ?? '') + attendeeLine;
    }
  }

  // --- Color ---
  const colorId = syncRule.override_color ?? sourceEvent.colorId ?? undefined;

  // --- Visibility ---
  const visibility = syncRule.target_visibility ?? 'private';
  if (!['private', 'default'].includes(visibility)) {
    throw new Error(`Unsupported target_visibility "${visibility}"`);
  }

  // --- Build target event ---
  const targetEvent = {
    summary: title,
    start: sourceEvent.start,
    end: sourceEvent.end,
    visibility,
    reminders: {
      useDefault: false,
      overrides: [],
    },
  };

  if (sourceEvent.start?.timeZone) targetEvent.start = { ...sourceEvent.start };
  if (sourceEvent.end?.timeZone) targetEvent.end = { ...sourceEvent.end };

  // --- Conference link (appended to description, never copied as conferenceData — Google API ignores copied conferenceData) ---
  logger.debug(`[transformService] copy_conference_link: ${syncRule.copy_conference_link}`);
  logger.debug(`[transformService] conferenceData present: ${Boolean(sourceEvent.conferenceData)}`);
  logger.debug(`[transformService] entryPoints count: ${sourceEvent.conferenceData?.entryPoints?.length ?? 0}`);

  if (syncRule.copy_conference_link && sourceEvent.conferenceData?.entryPoints) {
    const videoEntry = sourceEvent.conferenceData.entryPoints.find((e) => e.entryPointType === 'video');
    logger.debug(`[transformService] videoEntry found: ${Boolean(videoEntry)}`);
    if (videoEntry?.uri) {
      const meetLine = `\n\n📹 Google Meet: ${videoEntry.uri}`;
      description = (description ?? '') + meetLine;
      logger.debug('[transformService] Meet line appended to description.');
    }
  }

  if (colorId !== undefined) targetEvent.colorId = String(colorId);
  if (syncRule.copy_location && sourceEvent.location) targetEvent.location = sourceEvent.location;

  // Assign description after all appends are done
  if (description !== undefined) targetEvent.description = description;

  return targetEvent;
}

module.exports = { transformEvent };
