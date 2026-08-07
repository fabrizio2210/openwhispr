const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const notificationPreferenceSchema = require("../../src/config/notificationPreferencesSchema.json");
const sharedNotificationPreferenceSnapshot = require("../../src/config/notificationPreferenceSnapshot.cjs");

const MeetingDetectionEngine = require("../../src/helpers/meetingDetectionEngine");
const debugLogger = require("../../src/helpers/debugLogger");
const {
  MEETING_DETECTION_PREF_KEYS,
  NOTIFICATION_PREFERENCE_KEYS,
  NOTIFICATION_SOURCES,
  createDefaultNotificationPreferences,
  createNotificationPreferenceSnapshot,
  getNotificationPreferenceKeysForSource,
  isNotificationPreferenceSnapshot,
  normalizeNotificationPreferenceSnapshot,
  syncMeetingNotificationPreferences,
} = require("../../src/helpers/meetingNotificationPreferences");

function completeNotificationPreferences(overrides = {}) {
  return {
    ...createDefaultNotificationPreferences(),
    ...overrides,
  };
}

class FakeDetector extends EventEmitter {
  constructor() {
    super();
    this.startCount = 0;
    this.stopCount = 0;
    this.dismissCount = 0;
    this.resetPromptCount = 0;
  }

  start() {
    this.startCount += 1;
  }

  stop() {
    this.stopCount += 1;
  }

  dismiss() {
    this.dismissCount += 1;
  }

  resetPrompt() {
    this.resetPromptCount += 1;
  }

  setUserRecording() {}
}

function createHarness({
  calendarEvent = null,
  calendarState = null,
  context = null,
  saveNoteSucceeds = true,
  meetingsFolderExists = true,
} = {}) {
  const processDetector = new FakeDetector();
  const audioDetector = new FakeDetector();
  const prompts = [];
  const savedTitles = [];
  const consumedCandidateIds = [];
  const contextProvider = {
    reconnectCount: 0,
    startCount: 0,
    stopCount: 0,
    start() {
      this.startCount += 1;
    },
    stop() {
      this.stopCount += 1;
    },
    getBestCandidate() {
      return context;
    },
    consumeCandidate(id) {
      consumedCandidateIds.push(id);
      return true;
    },
    reconnect() {
      this.reconnectCount += 1;
      return true;
    },
  };
  const googleCalendarManager = {
    getActiveMeetingState() {
      if (calendarState) return calendarState;
      return calendarEvent
        ? { activeMeeting: calendarEvent, activeEvents: [], upcomingEvents: [] }
        : { activeMeeting: null, activeEvents: [], upcomingEvents: [] };
    },
  };
  const windowManager = {
    notificationPrefs: {
      notificationsEnabled: true,
      notifyMeetingDetection: true,
      notifyCalendarReminders: true,
    },
    showMeetingNotification(prompt) {
      prompts.push(prompt);
    },
    dismissMeetingNotification() {},
    async queueMeetingNoteNavigation() {},
  };
  const databaseManager = {
    getActiveEvents() {
      return [];
    },
    getCalendarEventById(eventId) {
      const candidates = [
        calendarEvent,
        calendarState?.activeMeeting,
        ...(calendarState?.activeEvents ?? []),
        ...(calendarState?.upcomingEvents ?? []),
      ];
      return candidates.find((event) => event?.id === eventId) ?? null;
    },
    saveNote(title) {
      savedTitles.push(title);
      return saveNoteSucceeds ? { note: { id: "note-id", title } } : null;
    },
    updateNote(_noteId, updates) {
      return { success: true, note: { id: "note-id", ...updates } };
    },
    getMeetingsFolder() {
      return meetingsFolderExists ? { id: "folder-id" } : null;
    },
  };
  const engine = new MeetingDetectionEngine(
    googleCalendarManager,
    processDetector,
    audioDetector,
    windowManager,
    databaseManager,
    contextProvider
  );
  engine.broadcastToWindows = () => {};

  return {
    audioDetector,
    consumedCandidateIds,
    contextProvider,
    engine,
    processDetector,
    prompts,
    savedTitles,
  };
}

const OUTLOOK_CONTEXT = {
  id: 7,
  title: "Test meeting",
  scheduledAt: Date.now() - 5 * 60 * 1000,
  receivedAt: Date.now() - 10 * 60 * 1000,
  source: "outlook-notification",
  transport: "freedesktop",
};

test("uses Outlook notification context for an automatic meeting prompt", () => {
  const harness = createHarness({ context: OUTLOOK_CONTEXT });

  harness.audioDetector.emit("sustained-audio-detected", {
    durationMs: 10_000,
    detectedAt: Date.now(),
  });

  assert.equal(harness.prompts.length, 1);
  assert.equal(harness.prompts[0].event.summary, "Test meeting");
  assert.equal(harness.prompts[0].event.calendar_id, "__detected__");
  assert.equal(harness.prompts[0].variant, "underway");
  assert.equal(harness.prompts[0].joinUrl, null);
  assert.deepEqual(harness.consumedCandidateIds, []);
});

test("consumes the selected Outlook context after accepting an automatic prompt", async () => {
  const harness = createHarness({ context: OUTLOOK_CONTEXT });

  harness.audioDetector.emit("sustained-audio-detected", {
    durationMs: 10_000,
    detectedAt: Date.now(),
  });
  await harness.engine.handleNotificationResponse("audio:sustained-audio", "start");

  assert.deepEqual(harness.savedTitles, ["Test meeting"]);
  assert.deepEqual(harness.consumedCandidateIds, [OUTLOOK_CONTEXT.id]);
  assert.equal(harness.audioDetector.resetPromptCount, 0);
});

test("ending meeting mode does not bypass verified audio inactivity", () => {
  const harness = createHarness({ context: OUTLOOK_CONTEXT });

  harness.engine.setMeetingModeActive(true);
  harness.engine.setMeetingModeActive(false);

  assert.equal(harness.audioDetector.resetPromptCount, 0);
});

test("does not consume Outlook context when a prompt is dismissed", async () => {
  const harness = createHarness({ context: OUTLOOK_CONTEXT });

  harness.audioDetector.emit("sustained-audio-detected", {
    durationMs: 10_000,
    detectedAt: Date.now(),
  });
  await harness.engine.handleNotificationResponse("audio:sustained-audio", "dismiss");

  assert.deepEqual(harness.consumedCandidateIds, []);
  assert.equal(harness.audioDetector.dismissCount, 1);
});

test("dismissing a calendar reminder leaves later audio detection armed", async () => {
  const calendarEvent = {
    id: "calendar-event",
    calendar_id: "primary",
    summary: "Calendar title",
    start_time: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    end_time: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
  };
  const harness = createHarness({ calendarEvent });

  harness.engine.handleCalendarReminder(calendarEvent);
  await harness.engine.handleNotificationResponse("calendar:calendar-event", "dismiss");

  assert.equal(harness.audioDetector.dismissCount, 0);
  harness.audioDetector.emit("sustained-audio-detected", {
    durationMs: 10_000,
    detectedAt: Date.now(),
  });
  assert.equal(harness.prompts.length, 2);
});

test("does not consume Outlook context when a prompt times out", () => {
  const harness = createHarness({ context: OUTLOOK_CONTEXT });

  harness.audioDetector.emit("sustained-audio-detected", {
    durationMs: 10_000,
    detectedAt: Date.now(),
  });
  harness.engine.handleNotificationTimeout();

  assert.deepEqual(harness.consumedCandidateIds, []);
});

test("does not consume Outlook context when meeting note creation fails", async () => {
  const harness = createHarness({
    context: OUTLOOK_CONTEXT,
    saveNoteSucceeds: false,
  });

  harness.audioDetector.emit("sustained-audio-detected", {
    durationMs: 10_000,
    detectedAt: Date.now(),
  });
  await harness.engine.handleNotificationResponse("audio:sustained-audio", "start");

  assert.deepEqual(harness.consumedCandidateIds, []);
});

test("keeps Google Calendar title precedence over notification context", () => {
  const calendarEvent = {
    id: "calendar-event",
    calendar_id: "primary",
    summary: "Calendar title",
    start_time: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    end_time: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
  };
  const harness = createHarness({ calendarEvent, context: OUTLOOK_CONTEXT });

  harness.audioDetector.emit("sustained-audio-detected", {
    durationMs: 10_000,
    detectedAt: Date.now(),
  });

  assert.equal(harness.prompts[0].event, calendarEvent);
});

test("uses an active database calendar event before notification context", () => {
  const activeEvent = {
    id: "active-event",
    calendar_id: "primary",
    summary: "Active calendar title",
    start_time: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    end_time: new Date(Date.now() + 50 * 60 * 1000).toISOString(),
  };
  const harness = createHarness({
    calendarState: {
      activeMeeting: null,
      activeEvents: [activeEvent],
      upcomingEvents: [],
    },
    context: OUTLOOK_CONTEXT,
  });

  harness.audioDetector.emit("sustained-audio-detected", {
    durationMs: 10_000,
    detectedAt: Date.now(),
  });

  assert.equal(harness.prompts[0].event, activeEvent);
});

test("uses Outlook notification context for manual meeting starts", async () => {
  const harness = createHarness({ context: OUTLOOK_CONTEXT });

  await harness.engine.startManualMeeting();

  assert.deepEqual(harness.savedTitles, ["Test meeting"]);
  assert.deepEqual(harness.consumedCandidateIds, [OUTLOOK_CONTEXT.id]);
});

test("uses an imminent Google Calendar event before Outlook for manual starts", async () => {
  const upcomingEvent = {
    id: "upcoming-event",
    calendar_id: "primary",
    summary: "Upcoming calendar title",
    start_time: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    end_time: new Date(Date.now() + 62 * 60 * 1000).toISOString(),
  };
  const harness = createHarness({
    calendarState: {
      activeMeeting: null,
      activeEvents: [],
      upcomingEvents: [upcomingEvent],
    },
    context: OUTLOOK_CONTEXT,
  });

  await harness.engine.startManualMeeting();

  assert.deepEqual(harness.savedTitles, ["Upcoming calendar title"]);
  assert.deepEqual(harness.consumedCandidateIds, []);
});

test("falls back to New note without eligible notification context", () => {
  const harness = createHarness();

  harness.audioDetector.emit("sustained-audio-detected", {
    durationMs: 10_000,
    detectedAt: Date.now(),
  });

  assert.equal(harness.prompts[0].event.summary, "New note");
});

test("does not log raw notification-context errors", () => {
  const harness = createHarness();
  const rawError = "Sensitive title, body, and /private/path";
  harness.engine.meetingTitleContextProvider.getBestCandidate = () => {
    throw new Error(rawError);
  };
  const originalWarn = debugLogger.warn;
  let warning;
  debugLogger.warn = (...args) => {
    warning = args;
  };

  try {
    harness.audioDetector.emit("sustained-audio-detected", {
      durationMs: 10_000,
      detectedAt: Date.now(),
    });
  } finally {
    debugLogger.warn = originalWarn;
  }

  assert.deepEqual(warning, [
    "Failed to resolve notification meeting title",
    { failureType: "candidate-resolution", retrying: false },
    "meeting",
  ]);
  assert.equal(JSON.stringify(warning).includes(rawError), false);
  assert.equal(harness.prompts[0].event.summary, "New note");
});

test("waits for explicit notification preference sync before monitoring", () => {
  const harness = createHarness({ context: OUTLOOK_CONTEXT });

  harness.engine.start();
  assert.equal(harness.contextProvider.startCount, 0);

  harness.engine.setPreferences({ audioDetection: true });
  assert.equal(harness.contextProvider.startCount, 0);

  harness.engine.setNotificationContextEnabled(false);
  assert.equal(harness.contextProvider.stopCount, 0);

  harness.engine.setNotificationContextEnabled(true);
  assert.equal(harness.contextProvider.startCount, 1);

  harness.engine.setPreferences({ audioDetection: false });
  assert.equal(harness.contextProvider.stopCount, 0);

  harness.engine.setNotificationContextEnabled(false);
  assert.equal(harness.contextProvider.stopCount, 1);
  harness.engine.stop();
  assert.equal(harness.contextProvider.stopCount, 2);
});

test("reconnects notification context after resume only while monitoring is active", () => {
  const harness = createHarness({ context: OUTLOOK_CONTEXT });

  assert.equal(harness.engine.onWakeFromSleep(), false);
  harness.engine.start();
  assert.equal(harness.engine.onWakeFromSleep(), false);

  harness.engine.setNotificationContextEnabled(true);
  assert.equal(harness.engine.onWakeFromSleep(), true);
  assert.equal(harness.contextProvider.reconnectCount, 1);

  harness.engine.setNotificationContextEnabled(false);
  assert.equal(harness.engine.onWakeFromSleep(), false);
  assert.equal(harness.contextProvider.reconnectCount, 1);
});

test("applies disabled persisted notification preferences before monitoring", () => {
  const harness = createHarness({ context: OUTLOOK_CONTEXT });
  const notificationPreferences = completeNotificationPreferences();

  harness.engine.start();
  syncMeetingNotificationPreferences(
    notificationPreferences,
    completeNotificationPreferences({ notifyMeetingDetection: false }),
    harness.engine
  );

  assert.equal(notificationPreferences.notifyMeetingDetection, false);
  assert.equal(harness.engine.getPreferences().audioDetection, false);
  assert.equal(harness.contextProvider.startCount, 0);

  syncMeetingNotificationPreferences(
    notificationPreferences,
    completeNotificationPreferences(),
    harness.engine
  );
  assert.equal(harness.contextProvider.startCount, 1);
});

test("does not monitor until the required typed meeting preferences are synchronized", () => {
  const harness = createHarness({ context: OUTLOOK_CONTEXT });
  const notificationPreferences = completeNotificationPreferences();
  const originalPreferences = { ...notificationPreferences };
  harness.engine.start();

  for (const invalidPreferences of [
    { notifyUpdates: false },
    { notifyMeetingDetection: true },
    { meetingDetectionNotifications: true },
    { notificationsEnabled: undefined, notifyMeetingDetection: true },
    { notificationsEnabled: true, notifyMeetingDetection: "yes" },
  ]) {
    assert.equal(isNotificationPreferenceSnapshot(invalidPreferences), false);
    assert.equal(
      syncMeetingNotificationPreferences(
        notificationPreferences,
        invalidPreferences,
        harness.engine
      ),
      false
    );
    assert.deepEqual(notificationPreferences, originalPreferences);
    assert.equal(harness.contextProvider.startCount, 0);
  }

  syncMeetingNotificationPreferences(
    notificationPreferences,
    completeNotificationPreferences(),
    harness.engine
  );
  assert.equal(harness.contextProvider.startCount, 1);
});

test("accepts required meeting preferences without exact notification-schema coupling", () => {
  for (const validSnapshot of [
    { notificationsEnabled: true, notifyMeetingDetection: true },
    {
      notificationsEnabled: true,
      notifyMeetingDetection: true,
      unknownPreference: true,
    },
    {
      notificationsEnabled: true,
      notifyMeetingDetection: true,
      notifyCalendarReminders: "invalid",
      renamedPreference: false,
    },
  ]) {
    const harness = createHarness({ context: OUTLOOK_CONTEXT });
    const notificationPreferences = completeNotificationPreferences();
    harness.engine.start();

    assert.equal(isNotificationPreferenceSnapshot(validSnapshot), true);
    assert.equal(
      syncMeetingNotificationPreferences(notificationPreferences, validSnapshot, harness.engine),
      true
    );
    assert.equal(harness.contextProvider.startCount, 1);
    assert.equal(notificationPreferences.notificationsEnabled, true);
    assert.equal(notificationPreferences.notifyMeetingDetection, true);
    assert.equal(notificationPreferences.notifyCalendarReminders, true);
    assert.equal(Object.hasOwn(notificationPreferences, "unknownPreference"), false);
    assert.equal(Object.hasOwn(notificationPreferences, "renamedPreference"), false);
  }
});

test("builds versioned snapshots from every key in the shared notification schema", () => {
  assert.equal(
    createNotificationPreferenceSnapshot,
    sharedNotificationPreferenceSnapshot.createNotificationPreferenceSnapshot
  );
  const snapshot = createNotificationPreferenceSnapshot({
    notificationsEnabled: false,
    notifyMeetingDetection: false,
    unknownPreference: false,
  });

  assert.equal(snapshot.notificationPreferencesVersion, 1);
  assert.deepEqual(
    Object.keys(snapshot).filter((key) => key !== "notificationPreferencesVersion"),
    NOTIFICATION_PREFERENCE_KEYS
  );
  assert.equal(snapshot.notificationsEnabled, false);
  assert.equal(snapshot.notifyMeetingDetection, false);
  assert.equal(Object.hasOwn(snapshot, "unknownPreference"), false);

  const aliasedSnapshot = createNotificationPreferenceSnapshot({
    notificationsEnabled: true,
    meetingDetectionNotifications: false,
  });
  assert.equal(aliasedSnapshot.notifyMeetingDetection, false);

  const extendedSchema = structuredClone(notificationPreferenceSchema);
  extendedSchema.preferences.fifthPreference = {
    default: true,
    required: false,
    aliases: [],
    meetingDetectionGate: false,
    notificationSources: [],
  };
  const extendedSnapshot = createNotificationPreferenceSnapshot(
    {
      ...completeNotificationPreferences(),
      fifthPreference: false,
    },
    extendedSchema
  );
  assert.equal(extendedSnapshot.fifthPreference, false);
});

test("rechecks notification preferences before flushing a queued detection", () => {
  const harness = createHarness({ context: OUTLOOK_CONTEXT });
  harness.engine.setUserRecording(true);
  harness.audioDetector.emit("sustained-audio-detected", {
    durationMs: 10_000,
    detectedAt: Date.now(),
  });
  assert.equal(harness.prompts.length, 0);
  assert.equal(harness.engine.activeDetections.has("audio:sustained-audio"), true);

  harness.engine.windowManager.notificationPrefs.notificationsEnabled = false;
  harness.engine._flushNotificationQueue();

  assert.equal(harness.prompts.length, 0);
  assert.equal(harness.engine.activeDetections.has("audio:sustained-audio"), false);
});

test("derives meeting gates and per-source notification routing from schema metadata", () => {
  assert.deepEqual(MEETING_DETECTION_PREF_KEYS, ["notificationsEnabled", "notifyMeetingDetection"]);
  assert.deepEqual(getNotificationPreferenceKeysForSource(NOTIFICATION_SOURCES.AUDIO), [
    "notificationsEnabled",
    "notifyMeetingDetection",
  ]);
  assert.deepEqual(getNotificationPreferenceKeysForSource(NOTIFICATION_SOURCES.CALENDAR), [
    "notificationsEnabled",
    "notifyCalendarReminders",
  ]);
  assert.equal(getNotificationPreferenceKeysForSource("future-source"), null);

  const harness = createHarness({ context: OUTLOOK_CONTEXT });
  harness.engine.windowManager.notificationPrefs.notifyMeetingDetection = false;
  assert.equal(harness.engine._notificationsEnabledFor(NOTIFICATION_SOURCES.AUDIO), false);
  assert.equal(harness.engine._notificationsEnabledFor(NOTIFICATION_SOURCES.CALENDAR), true);

  harness.engine.windowManager.notificationPrefs.notifyCalendarReminders = false;
  assert.equal(harness.engine._notificationsEnabledFor(NOTIFICATION_SOURCES.CALENDAR), false);
  assert.equal(harness.engine._notificationsEnabledFor("future-source"), false);
});

test("migrates the renamed meeting notification preference alias", () => {
  const harness = createHarness({ context: OUTLOOK_CONTEXT });
  const notificationPreferences = completeNotificationPreferences();
  const renamedSnapshot = {
    notificationPreferencesVersion: 0,
    notificationsEnabled: true,
    meetingDetectionNotifications: false,
  };
  harness.engine.start();

  assert.equal(isNotificationPreferenceSnapshot(renamedSnapshot), true);
  assert.equal(
    syncMeetingNotificationPreferences(notificationPreferences, renamedSnapshot, harness.engine),
    false
  );
  assert.equal(notificationPreferences.notifyMeetingDetection, false);
  assert.equal(Object.hasOwn(notificationPreferences, "meetingDetectionNotifications"), false);
});

test("preserves removed optional values and ignores added or unknown fields", () => {
  const currentPreferences = completeNotificationPreferences({
    notifyCalendarReminders: false,
  });
  const normalized = normalizeNotificationPreferenceSnapshot(
    {
      notificationPreferencesVersion: 2,
      notificationsEnabled: true,
      notifyMeetingDetection: true,
      addedFuturePreference: false,
      removedLegacyPreference: true,
    },
    currentPreferences
  );

  assert.deepEqual(normalized, currentPreferences);
  assert.equal(Object.hasOwn(normalized, "addedFuturePreference"), false);
  assert.equal(Object.hasOwn(normalized, "removedLegacyPreference"), false);
  assert.equal(
    isNotificationPreferenceSnapshot({
      notificationPreferencesVersion: "invalid",
      notificationsEnabled: true,
      notifyMeetingDetection: true,
    }),
    false
  );
});

test("preserves notification monitoring when a later preference snapshot is incomplete", () => {
  for (const invalidSnapshot of [
    { notificationsEnabled: true },
    { notifyUpdates: false },
    { notificationsEnabled: true, notifyMeetingDetection: "yes" },
  ]) {
    const harness = createHarness({ context: OUTLOOK_CONTEXT });
    const notificationPreferences = completeNotificationPreferences();
    harness.engine.start();

    syncMeetingNotificationPreferences(
      notificationPreferences,
      completeNotificationPreferences(),
      harness.engine
    );
    assert.equal(harness.contextProvider.startCount, 1);

    assert.equal(
      syncMeetingNotificationPreferences(notificationPreferences, invalidSnapshot, harness.engine),
      true
    );
    assert.deepEqual(notificationPreferences, completeNotificationPreferences());
    assert.equal(harness.engine.getPreferences().audioDetection, true);
    assert.equal(harness.contextProvider.stopCount, 0);
  }
});

test("preserves notification monitoring for malformed top-level preference snapshots", () => {
  for (const malformedSnapshot of [null, "invalid", true, [], new Date(), new Map(), /invalid/]) {
    const harness = createHarness({ context: OUTLOOK_CONTEXT });
    const notificationPreferences = completeNotificationPreferences();
    harness.engine.start();

    syncMeetingNotificationPreferences(
      notificationPreferences,
      completeNotificationPreferences(),
      harness.engine
    );
    assert.equal(harness.contextProvider.startCount, 1);
    assert.equal(isNotificationPreferenceSnapshot(malformedSnapshot), false);

    assert.equal(
      syncMeetingNotificationPreferences(
        notificationPreferences,
        malformedSnapshot,
        harness.engine
      ),
      true
    );
    assert.deepEqual(notificationPreferences, completeNotificationPreferences());
    assert.equal(harness.engine.getPreferences().audioDetection, true);
    assert.equal(harness.contextProvider.stopCount, 0);
  }
});
