const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const {
  NotificationDismissTimer,
  getNotificationTimeoutMs,
} = require("../../src/helpers/notificationTimer");
const notificationTimerModulePath = require.resolve("../../src/helpers/notificationTimer");
const meetingNotificationPreferencesModulePath =
  require.resolve("../../src/helpers/meetingNotificationPreferences");
const notificationPreferenceSchemaModulePath =
  require.resolve("../../src/config/notificationPreferencesSchema.json");
const notificationPreferenceSchema = require(notificationPreferenceSchemaModulePath);

function loadNotificationTimerWithSchema(schema) {
  const originalLoad = Module._load;
  delete require.cache[notificationTimerModulePath];
  delete require.cache[meetingNotificationPreferencesModulePath];
  Module._load = function loadWithSchema(request, parent, isMain) {
    if (
      Module._resolveFilename(request, parent, isMain) === notificationPreferenceSchemaModulePath
    ) {
      return schema;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(notificationTimerModulePath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[notificationTimerModulePath];
    delete require.cache[meetingNotificationPreferencesModulePath];
  }
}

test("calendar prompts outlive the 60s reminder lead; detections keep 30s", () => {
  assert.ok(
    getNotificationTimeoutMs("calendar") > 60 * 1000,
    "a calendar prompt must survive past the meeting start"
  );
  assert.equal(getNotificationTimeoutMs("audio"), 30 * 1000);
});

test("calendar timeout follows a calendar source renamed in the schema", () => {
  const schema = structuredClone(notificationPreferenceSchema);
  schema.sources.CALENDAR = "calendar-v2";
  schema.preferences.notifyCalendarReminders.notificationSources = ["calendar-v2"];
  const { getNotificationTimeoutMs: getRenamedNotificationTimeoutMs } =
    loadNotificationTimerWithSchema(schema);

  assert.ok(
    getRenamedNotificationTimeoutMs("calendar-v2") > 60 * 1000,
    "the schema-derived calendar source must keep the reminder visible past the meeting start"
  );
  assert.equal(getRenamedNotificationTimeoutMs("calendar"), 30 * 1000);
});

test("fires exactly once after the configured duration", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let fired = 0;
  const timer = new NotificationDismissTimer(() => fired++);

  timer.start(30_000);
  t.mock.timers.tick(29_999);
  assert.equal(fired, 0);
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
  t.mock.timers.tick(60_000);
  assert.equal(fired, 1);
});

test("pause halts the countdown", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let fired = 0;
  const timer = new NotificationDismissTimer(() => fired++);

  timer.start(30_000);
  t.mock.timers.tick(29_000);
  timer.pause();
  t.mock.timers.tick(120_000);

  assert.equal(fired, 0, "a paused timer must never fire");
});

test("resume continues with the remaining time", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let fired = 0;
  const timer = new NotificationDismissTimer(() => fired++);

  timer.start(30_000);
  t.mock.timers.tick(10_000);
  timer.pause();
  t.mock.timers.tick(120_000);
  timer.resume();
  t.mock.timers.tick(19_999);
  assert.equal(fired, 0, "the countdown must pick up where it left off");
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
});

test("resume keeps a minimum runway", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let fired = 0;
  const timer = new NotificationDismissTimer(() => fired++);

  timer.start(30_000);
  t.mock.timers.tick(29_500);
  timer.pause();
  timer.resume();
  t.mock.timers.tick(500);
  assert.equal(fired, 0, "the card must not vanish right as the pointer leaves");
  t.mock.timers.tick(4_500);
  assert.equal(fired, 1);
});

test("cancel prevents firing and clears any paused state", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let fired = 0;
  const timer = new NotificationDismissTimer(() => fired++);

  timer.start(30_000);
  timer.pause();
  timer.cancel();
  timer.resume();
  t.mock.timers.tick(120_000);

  assert.equal(fired, 0, "cancel must also discard the paused remainder");
});

test("pause and resume without a started timer are no-ops", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let fired = 0;
  const timer = new NotificationDismissTimer(() => fired++);

  timer.pause();
  timer.resume();
  t.mock.timers.tick(120_000);

  assert.equal(fired, 0);
});

test("start replaces a running countdown", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let fired = 0;
  const timer = new NotificationDismissTimer(() => fired++);

  timer.start(30_000);
  t.mock.timers.tick(29_000);
  timer.start(30_000);
  t.mock.timers.tick(29_999);
  assert.equal(fired, 0, "the old deadline must not survive a restart");
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
});
