// The renderer cannot execute this local CommonJS module in Vite's browser/SSR
// bundle. Keep its browser-safe TypeScript counterpart behaviorally identical;
// notificationPreferencePersistence.test.js enforces the shared contract.
function resolveSchema(schema) {
  return schema ?? require("./notificationPreferencesSchema.json");
}

function getNotificationPreferenceKeys(schema) {
  schema = resolveSchema(schema);
  return Object.keys(schema.preferences);
}

function parseStoredBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function createNotificationPreferenceSnapshot(source = {}, schema) {
  schema = resolveSchema(schema);
  const snapshot = {
    [schema.versionKey]: schema.version,
  };

  for (const [key, definition] of Object.entries(schema.preferences)) {
    const candidateKeys = [key, ...definition.aliases];
    const sourceKey = candidateKeys.find((candidate) => typeof source[candidate] === "boolean");
    snapshot[key] = sourceKey ? source[sourceKey] : definition.default;
  }

  return snapshot;
}

function readNotificationPreferenceState(storage, schema) {
  schema = resolveSchema(schema);
  const preferences = {};

  if (storage) {
    for (const retiredKey of schema.retiredKeys ?? []) {
      storage.removeItem(retiredKey);
    }
  }

  for (const [key, definition] of Object.entries(schema.preferences)) {
    let value;
    let sourceKey;
    if (storage) {
      for (const candidate of [key, ...definition.aliases]) {
        const parsed = parseStoredBoolean(storage.getItem(candidate));
        if (parsed !== undefined) {
          value = parsed;
          sourceKey = candidate;
          break;
        }
      }
    }

    preferences[key] = value ?? definition.default;

    // Canonicalize legacy names as soon as the renderer hydrates. This keeps
    // later snapshots independent of renamed localStorage keys.
    if (storage && sourceKey && sourceKey !== key) {
      storage.setItem(key, String(preferences[key]));
    }
    if (storage) {
      for (const alias of definition.aliases) {
        storage.removeItem(alias);
      }
    }
  }

  return preferences;
}

function writeNotificationPreference(storage, key, value, schema) {
  schema = resolveSchema(schema);
  const definition = schema.preferences[key];
  if (!definition || typeof value !== "boolean") return false;
  if (!storage) return true;

  storage.setItem(key, String(value));
  for (const alias of definition.aliases) {
    storage.removeItem(alias);
  }
  return true;
}

module.exports = {
  createNotificationPreferenceSnapshot,
  getNotificationPreferenceKeys,
  readNotificationPreferenceState,
  writeNotificationPreference,
};
