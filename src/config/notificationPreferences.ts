import notificationPreferenceSchema from "./notificationPreferencesSchema.json";

// The Electron main process consumes a CommonJS counterpart because it cannot
// load this TypeScript/browser module. Keep both implementations aligned;
// notificationPreferencePersistence.test.js runs parity cases against them.

export type NotificationPreferenceSnapshot = Record<string, boolean | number>;
export type NotificationPreferenceKey = keyof typeof notificationPreferenceSchema.preferences;
export type NotificationPreferenceValues = Record<NotificationPreferenceKey, boolean>;

const NOTIFICATION_PREFERENCE_COMPATIBILITY_KEYS = [
  "notificationsEnabled",
  "notifyMeetingDetection",
  "notifyCalendarReminders",
  "notifyUpdates",
] as const;

export type NotificationPreferenceCompatibilityKey =
  (typeof NOTIFICATION_PREFERENCE_COMPATIBILITY_KEYS)[number];

const schemaPreferences = notificationPreferenceSchema.preferences as Record<
  string,
  { default: boolean }
>;
const NOTIFICATION_PREFERENCE_COMPATIBILITY_DEFAULTS = Object.fromEntries(
  NOTIFICATION_PREFERENCE_COMPATIBILITY_KEYS.map((key) => [
    key,
    schemaPreferences[key]?.default ?? true,
  ])
) as Record<NotificationPreferenceCompatibilityKey, boolean>;

type NotificationPreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const NOTIFICATION_PREFERENCE_KEYS = Object.keys(
  notificationPreferenceSchema.preferences
) as NotificationPreferenceKey[];

export function resolveNotificationPreferenceKey(
  candidate: string
): NotificationPreferenceKey | null {
  for (const [key, definition] of Object.entries(notificationPreferenceSchema.preferences)) {
    if (candidate === key || definition.aliases.includes(candidate)) {
      return key as NotificationPreferenceKey;
    }
  }
  return null;
}

export function readNotificationPreferenceValue(
  source: object,
  compatibilityKey: NotificationPreferenceCompatibilityKey
): boolean {
  const canonicalKey = resolveNotificationPreferenceKey(compatibilityKey);
  const value = canonicalKey ? (source as Record<string, unknown>)[canonicalKey] : undefined;
  return typeof value === "boolean"
    ? value
    : NOTIFICATION_PREFERENCE_COMPATIBILITY_DEFAULTS[compatibilityKey];
}

export const createNotificationPreferenceSnapshot = (
  source: object
): NotificationPreferenceSnapshot => {
  const values = source as Record<string, unknown>;
  const snapshot: NotificationPreferenceSnapshot = {
    [notificationPreferenceSchema.versionKey]: notificationPreferenceSchema.version,
  };
  for (const [key, definition] of Object.entries(notificationPreferenceSchema.preferences)) {
    const sourceKey = [key, ...definition.aliases].find(
      (candidate) => typeof values[candidate] === "boolean"
    );
    snapshot[key] = sourceKey ? (values[sourceKey] as boolean) : definition.default;
  }
  return snapshot;
};

export const readNotificationPreferenceState = (
  storage: NotificationPreferenceStorage | null
): NotificationPreferenceValues => {
  const preferences = {} as NotificationPreferenceValues;

  for (const retiredKey of notificationPreferenceSchema.retiredKeys) {
    storage?.removeItem(retiredKey);
  }
  for (const [key, definition] of Object.entries(notificationPreferenceSchema.preferences)) {
    let value: boolean | undefined;
    let sourceKey: string | undefined;
    for (const candidate of [key, ...definition.aliases]) {
      const stored = storage?.getItem(candidate);
      if (stored === "true" || stored === "false") {
        value = stored === "true";
        sourceKey = candidate;
        break;
      }
    }

    const preferenceKey = key as NotificationPreferenceKey;
    preferences[preferenceKey] = value ?? definition.default;
    if (storage && sourceKey && sourceKey !== key) {
      storage.setItem(key, String(preferences[preferenceKey]));
    }
    for (const alias of definition.aliases) {
      storage?.removeItem(alias);
    }
  }
  return preferences;
};

export const writeNotificationPreference = (
  storage: NotificationPreferenceStorage | null,
  key: NotificationPreferenceKey,
  value: boolean
): boolean => {
  const definition = notificationPreferenceSchema.preferences[key];
  if (!definition || typeof value !== "boolean") return false;
  storage?.setItem(key, String(value));
  for (const alias of definition.aliases) {
    storage?.removeItem(alias);
  }
  return true;
};
