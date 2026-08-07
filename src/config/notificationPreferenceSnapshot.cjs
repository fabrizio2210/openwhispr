const defaultSchema = require("./notificationPreferencesSchema.json");

function createNotificationPreferenceSnapshot(source = {}, schema = defaultSchema) {
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

module.exports = { createNotificationPreferenceSnapshot };
