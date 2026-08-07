const notificationPreferenceSchema = require("../config/notificationPreferencesSchema.json");
const {
  createNotificationPreferenceSnapshot,
} = require("../config/notificationPreferenceSnapshot.cjs");

const NOTIFICATION_PREFERENCE_KEYS = Object.freeze(
  Object.keys(notificationPreferenceSchema.preferences)
);
const NOTIFICATION_SOURCES = Object.freeze({ ...notificationPreferenceSchema.sources });
const VALID_NOTIFICATION_SOURCES = new Set(Object.values(NOTIFICATION_SOURCES));
for (const definition of Object.values(notificationPreferenceSchema.preferences)) {
  for (const source of definition.notificationSources) {
    if (source !== "*" && !VALID_NOTIFICATION_SOURCES.has(source)) {
      throw new Error(`Unknown notification source in schema: ${source}`);
    }
  }
}
const MEETING_DETECTION_PREF_KEYS = Object.freeze(
  NOTIFICATION_PREFERENCE_KEYS.filter(
    (key) => notificationPreferenceSchema.preferences[key].meetingDetectionGate
  )
);
const explicitlySynchronizedPreferences = new WeakSet();

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
  } catch {
    return false;
  }

  return true;
}

function createDefaultNotificationPreferences() {
  return Object.fromEntries(
    NOTIFICATION_PREFERENCE_KEYS.map((key) => [
      key,
      notificationPreferenceSchema.preferences[key].default,
    ])
  );
}

function getNotificationPreferenceKeysForSource(source) {
  if (!VALID_NOTIFICATION_SOURCES.has(source)) return null;
  return NOTIFICATION_PREFERENCE_KEYS.filter((key) => {
    const sources = notificationPreferenceSchema.preferences[key].notificationSources;
    return sources.includes("*") || sources.includes(source);
  });
}

function normalizeNotificationPreferenceSnapshot(value, currentPreferences = {}) {
  if (!isPlainObject(value)) return null;

  const version = value[notificationPreferenceSchema.versionKey];
  if (version !== undefined && (!Number.isInteger(version) || version < 0)) return null;

  const normalized = {};
  for (const key of NOTIFICATION_PREFERENCE_KEYS) {
    const definition = notificationPreferenceSchema.preferences[key];
    const candidateKeys = [key, ...definition.aliases];
    const incomingKey = candidateKeys.find((candidate) =>
      Object.prototype.hasOwnProperty.call(value, candidate)
    );
    const incomingValue = incomingKey === undefined ? undefined : value[incomingKey];

    if (typeof incomingValue === "boolean") {
      normalized[key] = incomingValue;
    } else if (definition.required) {
      return null;
    } else {
      normalized[key] =
        typeof currentPreferences[key] === "boolean" ? currentPreferences[key] : definition.default;
    }
  }

  return normalized;
}

function isNotificationPreferenceSnapshot(value) {
  return normalizeNotificationPreferenceSnapshot(value) !== null;
}

function syncMeetingNotificationPreferences(currentPreferences, incomingPreferences, engine) {
  const normalizedPreferences = normalizeNotificationPreferenceSnapshot(
    incomingPreferences,
    currentPreferences
  );
  if (!normalizedPreferences) {
    return (
      explicitlySynchronizedPreferences.has(currentPreferences) &&
      MEETING_DETECTION_PREF_KEYS.every((key) => currentPreferences[key] === true)
    );
  }

  for (const key of NOTIFICATION_PREFERENCE_KEYS) {
    currentPreferences[key] = normalizedPreferences[key];
  }
  explicitlySynchronizedPreferences.add(currentPreferences);

  const meetingDetectionEnabled =
    explicitlySynchronizedPreferences.has(currentPreferences) &&
    MEETING_DETECTION_PREF_KEYS.every((key) => currentPreferences[key] === true);
  engine?.setPreferences({
    audioDetection: meetingDetectionEnabled,
  });
  engine?.setNotificationContextEnabled(meetingDetectionEnabled);

  return meetingDetectionEnabled;
}

module.exports = {
  MEETING_DETECTION_PREF_KEYS,
  NOTIFICATION_PREFERENCE_KEYS,
  NOTIFICATION_SOURCES,
  createDefaultNotificationPreferences,
  createNotificationPreferenceSnapshot,
  getNotificationPreferenceKeysForSource,
  isNotificationPreferenceSnapshot,
  normalizeNotificationPreferenceSnapshot,
  syncMeetingNotificationPreferences,
};
