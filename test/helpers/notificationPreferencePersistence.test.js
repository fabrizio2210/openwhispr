const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const ts = require("typescript");

const notificationPreferenceSchema = require("../../src/config/notificationPreferencesSchema.json");
const {
  createNotificationPreferenceSnapshot,
  readNotificationPreferenceState,
  writeNotificationPreference,
} = require("../../src/config/notificationPreferenceSnapshot.cjs");

function createStorage(entries = []) {
  const values = new Map(entries);
  return {
    values,
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function createMigratedSchema() {
  const schema = structuredClone(notificationPreferenceSchema);
  const renamedDefinition = schema.preferences.notifyMeetingDetection;
  delete schema.preferences.notifyMeetingDetection;
  schema.preferences.notifyMeetingDetectionV2 = {
    ...renamedDefinition,
    aliases: ["notifyMeetingDetection", ...renamedDefinition.aliases],
  };
  delete schema.preferences.notifyUpdates;
  schema.preferences.futurePreference = {
    default: false,
    required: false,
    aliases: [],
    meetingDetectionGate: false,
    notificationSources: [],
  };
  schema.retiredKeys = ["removedPreference", "notifyUpdates"];
  return schema;
}

test("schema persistence handles renamed, added, and removed preferences", () => {
  const schema = structuredClone(notificationPreferenceSchema);
  schema.retiredKeys = ["removedPreference"];
  schema.preferences.futurePreference = {
    default: false,
    required: false,
    aliases: [],
    meetingDetectionGate: false,
    notificationSources: [],
  };
  const storage = createStorage([
    ["notificationsEnabled", "true"],
    ["meetingDetectionNotifications", "false"],
    ["removedPreference", "true"],
  ]);

  const state = readNotificationPreferenceState(storage, schema);
  assert.equal(state.notifyMeetingDetection, false);
  assert.equal(state.futurePreference, false);
  assert.equal(Object.hasOwn(state, "removedPreference"), false);
  assert.equal(storage.values.has("removedPreference"), false);
  assert.equal(storage.values.get("notifyMeetingDetection"), "false");
  assert.equal(storage.values.has("meetingDetectionNotifications"), false);

  assert.equal(writeNotificationPreference(storage, "futurePreference", true, schema), true);
  assert.equal(storage.values.get("futurePreference"), "true");
  assert.equal(writeNotificationPreference(storage, "removedPreference", false, schema), false);

  const snapshot = createNotificationPreferenceSnapshot(
    { ...state, removedPreference: true },
    schema
  );
  assert.equal(snapshot.futurePreference, false);
  assert.equal(Object.hasOwn(snapshot, "removedPreference"), false);
});

test("renderer and main preference helpers obey the same persistence contract", async () => {
  const rendererHelpers = await import("../../src/config/notificationPreferences.ts");
  const cases = [
    [],
    [
      ["notificationsEnabled", "false"],
      ["meetingDetectionNotifications", "true"],
      ["notifyCalendarReminders", "invalid"],
      ["notifyUpdates", "false"],
    ],
  ];

  for (const entries of cases) {
    const mainStorage = createStorage(entries);
    const rendererStorage = createStorage(entries);
    const mainState = readNotificationPreferenceState(mainStorage);
    const rendererState = rendererHelpers.readNotificationPreferenceState(rendererStorage);

    assert.deepEqual(rendererState, mainState);
    assert.deepEqual([...rendererStorage.values], [...mainStorage.values]);
    assert.deepEqual(
      rendererHelpers.createNotificationPreferenceSnapshot(rendererState),
      createNotificationPreferenceSnapshot(mainState)
    );

    for (const key of Object.keys(notificationPreferenceSchema.preferences)) {
      const nextValue = !mainState[key];
      assert.equal(writeNotificationPreference(mainStorage, key, nextValue), true);
      assert.equal(
        rendererHelpers.writeNotificationPreference(rendererStorage, key, nextValue),
        true
      );
    }
    assert.deepEqual([...rendererStorage.values], [...mainStorage.values]);
  }
});

test("the actual settings store hydrates and writes every schema preference", async () => {
  const runtimeSchema = createMigratedSchema();
  const storage = createStorage([
    ["notificationsEnabled", "true"],
    ["meetingDetectionNotifications", "false"],
    ["notifyUpdates", "false"],
    ["removedPreference", "true"],
  ]);
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-settings-store-"));

  globalThis.localStorage = storage;
  globalThis.window = {
    localStorage: storage,
    addEventListener() {},
    removeEventListener() {},
    setInterval() {
      return { unref() {} };
    },
    clearInterval() {},
    electronAPI: {
      async syncNotificationPreferences() {
        return { success: true };
      },
    },
  };

  try {
    const { build } = await import("vite");
    const result = await build({
      root: path.resolve(__dirname, "../../src"),
      logLevel: "silent",
      plugins: [
        {
          name: "test-notification-preference-schema",
          enforce: "pre",
          load(id) {
            if (id.endsWith("/config/notificationPreferencesSchema.json")) {
              return JSON.stringify(runtimeSchema);
            }
            return null;
          },
        },
      ],
      build: {
        ssr: "stores/settingsStore.ts",
        write: false,
        rollupOptions: { output: { format: "es" } },
      },
      ssr: { noExternal: true },
    });
    const buildResult = Array.isArray(result) ? result[0] : result;
    const output = buildResult.output.find((entry) => entry.type === "chunk");
    assert.ok(output, "settings store bundle should contain a JavaScript chunk");

    const modulePath = path.join(tempDir, "settings-store.mjs");
    await fs.writeFile(modulePath, output.code);
    const { useSettingsStore } = await import(pathToFileURL(modulePath).href);
    const state = useSettingsStore.getState();

    for (const key of Object.keys(runtimeSchema.preferences)) {
      assert.equal(typeof state[key], "boolean", `${key} should be hydrated by the store`);
    }
    assert.equal(state.notifyMeetingDetectionV2, false);
    assert.equal(storage.values.get("notifyMeetingDetectionV2"), "false");
    assert.equal(storage.values.has("notifyMeetingDetection"), false);
    assert.equal(storage.values.has("meetingDetectionNotifications"), false);
    assert.equal(Object.hasOwn(state, "notifyUpdates"), false);
    assert.equal(storage.values.has("notifyUpdates"), false);
    assert.equal(storage.values.has("removedPreference"), false);

    state.setNotifyMeetingDetection(true);
    assert.equal(useSettingsStore.getState().notifyMeetingDetectionV2, true);
    assert.equal(storage.values.get("notifyMeetingDetectionV2"), "true");
    state.setNotifyUpdates(false);
    assert.equal(Object.hasOwn(useSettingsStore.getState(), "notifyUpdates"), false);

    for (const key of Object.keys(runtimeSchema.preferences)) {
      const nextValue = !useSettingsStore.getState()[key];
      assert.equal(state.setNotificationPreference(key, nextValue), true);
      assert.equal(useSettingsStore.getState()[key], nextValue);
      assert.equal(storage.values.get(key), String(nextValue));
    }
  } finally {
    globalThis.window = originalWindow;
    globalThis.localStorage = originalLocalStorage;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("settings store and hook type-check after a real preference rename and removal", () => {
  const runtimeSchema = createMigratedSchema();
  const sourceRoot = path.resolve(__dirname, "../../src");
  const tsconfigPath = path.join(sourceRoot, "tsconfig.json");
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  assert.equal(configFile.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, sourceRoot);
  const schemaPath = path.join(sourceRoot, "config/notificationPreferencesSchema.json");
  const host = ts.createCompilerHost({ ...parsed.options, noEmit: true });
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) =>
    path.resolve(fileName) === schemaPath ? JSON.stringify(runtimeSchema) : readFile(fileName);

  const program = ts.createProgram({
    rootNames: [
      path.join(sourceRoot, "vite-env.d.ts"),
      path.join(sourceRoot, "stores/settingsStore.ts"),
      path.join(sourceRoot, "hooks/useSettings.ts"),
    ],
    options: { ...parsed.options, noEmit: true },
    host,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    })
  );
});
