// The "App updates" toggle gates the automatic checks themselves, not just the
// popup: with it off the app must not reach the update feed, so offline or
// firewalled machines never surface a connection error dialog (#1605).
// Only an explicit false disables — missing prefs (renderer sync not arrived
// yet) keep check-by-default behavior.
const {
  NOTIFICATION_SOURCES,
  getNotificationPreferenceKeysForSource,
} = require("./meetingNotificationPreferences");

const UPDATE_NOTIFICATION_PREFERENCE_KEYS = getNotificationPreferenceKeysForSource(
  NOTIFICATION_SOURCES.UPDATES
);

function appUpdatesEnabled(preferences = {}) {
  return UPDATE_NOTIFICATION_PREFERENCE_KEYS.every((key) => preferences[key] !== false);
}

module.exports = { appUpdatesEnabled };
