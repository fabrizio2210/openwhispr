const { BrowserWindow, shell } = require("electron");
const debugLogger = require("./debugLogger");
const { getMeetingJoinUrl } = require("./meetingJoinUrl");
const {
  getNotificationPreferenceKeysForSource,
  NOTIFICATION_SOURCES,
} = require("./meetingNotificationPreferences");

const IMMINENT_THRESHOLD_MS = 5 * 60 * 1000;

const PLACEHOLDER_PREFIX = { __detected__: "detected", __manual__: "manual" };

function placeholderEvent(calendarId, context = null) {
  const now = context?.scheduledAt ?? Date.now();
  return {
    id: `${PLACEHOLDER_PREFIX[calendarId]}-${now}`,
    calendar_id: calendarId,
    summary: context?.title || "New note",
    start_time: new Date(now).toISOString(),
    end_time: new Date(now + 3600000).toISOString(),
    is_all_day: 0,
    status: "confirmed",
    hangout_link: null,
    conference_data: null,
    organizer_email: null,
    attendees_count: 0,
  };
}

class MeetingDetectionEngine {
  constructor(
    googleCalendarManager,
    meetingProcessDetector,
    audioActivityDetector,
    windowManager,
    databaseManager,
    meetingTitleContextProvider = null
  ) {
    this.googleCalendarManager = googleCalendarManager;
    this.meetingProcessDetector = meetingProcessDetector;
    this.audioActivityDetector = audioActivityDetector;
    this.windowManager = windowManager;
    this.databaseManager = databaseManager;
    this.meetingTitleContextProvider = meetingTitleContextProvider;
    this.activeDetections = new Map();
    this.preferences = { processDetection: true, audioDetection: true };
    this.notificationContextEnabled = false;
    this._started = false;
    this._userRecording = false;
    this._meetingModeActive = false;
    this._notificationQueue = [];
    this._postRecordingCooldown = null;
    this._bindListeners();
  }

  _bindListeners() {
    // Process detection is context-only — track running apps but don't trigger notifications.
    // This avoids false positives from apps like FaceTime running in the background.
    this.meetingProcessDetector.on("meeting-process-detected", (data) => {
      debugLogger.info(
        "Meeting app running (context only)",
        { processKey: data.processKey, appName: data.appName },
        "meeting"
      );
    });

    this.meetingProcessDetector.on("meeting-process-ended", (data) => {
      this.activeDetections.delete(`process:${data.processKey}`);
    });

    this.audioActivityDetector.on("sustained-audio-detected", (data) => {
      this._handleDetection(NOTIFICATION_SOURCES.AUDIO, "sustained-audio", data);
    });
  }

  // Calendar reminders enter the same pipeline as mic detections, so they share
  // the recording gates, queueing, cooldowns, and the overlay window.
  handleCalendarReminder(event) {
    this._handleDetection(NOTIFICATION_SOURCES.CALENDAR, event.id, {
      event,
      detectedAt: Date.now(),
    });
  }

  _handleDetection(source, key, data) {
    const detectionId = `${source}:${key}`;

    if (source === NOTIFICATION_SOURCES.AUDIO && !this.preferences.audioDetection) {
      debugLogger.debug("Audio detection disabled, ignoring", { detectionId }, "meeting");
      return;
    }

    if (!this._notificationsEnabledFor(source)) {
      debugLogger.info(
        "Notification disabled by preference, ignoring",
        { detectionId, source },
        "meeting"
      );
      return;
    }

    if (this.activeDetections.has(detectionId)) {
      debugLogger.debug("Detection already active, skipping", { detectionId }, "meeting");
      return;
    }

    if (this._meetingModeActive) {
      debugLogger.info(
        "Suppressing detection — meeting mode already active",
        { detectionId },
        "meeting"
      );
      return;
    }

    if (this._userRecording || this._postRecordingCooldown) {
      debugLogger.info("Detection queued — user is recording", { detectionId, source }, "meeting");
      this._notificationQueue.push({ source, key, data });
      this.activeDetections.set(detectionId, { source, key, data, dismissed: false });
      return;
    }

    debugLogger.info("Meeting detection triggered", { detectionId, source }, "meeting");
    this.activeDetections.set(detectionId, { source, key, data, dismissed: false });
    this._showPrompt(detectionId, source, key, data);
  }

  _notificationsEnabledFor(source) {
    const nPrefs = this.windowManager.notificationPrefs || {};
    const preferenceKeys = getNotificationPreferenceKeysForSource(source);
    return preferenceKeys !== null && preferenceKeys.every((key) => nPrefs[key] !== false);
  }

  // activeMeeting only means the event's scheduled window is open — actual meeting
  // recordings are tracked by _meetingModeActive.
  _findCalendarEvent() {
    const calendarState = this.googleCalendarManager?.getActiveMeetingState?.();
    if (calendarState?.activeMeeting) return calendarState.activeMeeting;

    const activeEvents = Array.isArray(calendarState?.activeEvents)
      ? calendarState.activeEvents
      : (this.databaseManager?.getActiveEvents?.() ?? []);
    if (activeEvents.length > 0) return activeEvents[0];

    const now = Date.now();
    return (
      calendarState?.upcomingEvents?.find((evt) => {
        const start = new Date(evt.start_time).getTime();
        return start - now <= IMMINENT_THRESHOLD_MS && start > now;
      }) ?? null
    );
  }

  _findNotificationContext() {
    try {
      return this.meetingTitleContextProvider?.getBestCandidate?.(Date.now()) ?? null;
    } catch {
      debugLogger.warn(
        "Failed to resolve notification meeting title",
        { failureType: "candidate-resolution", retrying: false },
        "meeting"
      );
      return null;
    }
  }

  _consumeNotificationContext(candidateId) {
    if (candidateId === null || candidateId === undefined) return false;
    try {
      return this.meetingTitleContextProvider?.consumeCandidate?.(candidateId) === true;
    } catch {
      debugLogger.warn(
        "Failed to consume notification meeting title",
        { failureType: "candidate-consumption", retrying: false },
        "meeting"
      );
      return false;
    }
  }

  _showPrompt(detectionId, source, key, data) {
    const calendarEvent = data?.event ?? this._findCalendarEvent();
    const notificationContext = calendarEvent ? null : this._findNotificationContext();
    const event =
      calendarEvent ?? placeholderEvent("__detected__", notificationContext ?? undefined);

    let variant = "detected";
    if (calendarEvent || notificationContext) {
      const started = new Date(event.start_time).getTime() <= Date.now();
      variant = started ? "underway" : "starting";
    }
    const joinUrl =
      source === NOTIFICATION_SOURCES.CALENDAR ? getMeetingJoinUrl(calendarEvent) : null;

    debugLogger.info(
      "Showing notification",
      {
        detectionId,
        source,
        variant,
        title: notificationContext ? null : (calendarEvent?.summary ?? null),
        titleSource: notificationContext
          ? "outlook-notification"
          : calendarEvent
            ? NOTIFICATION_SOURCES.CALENDAR
            : null,
        hasJoinUrl: !!joinUrl,
      },
      "meeting"
    );

    const detection = this.activeDetections.get(detectionId);
    if (detection) {
      detection.event = event;
      detection.notificationCandidateId = notificationContext?.id ?? null;
    }

    this.windowManager.showMeetingNotification({
      detectionId,
      source,
      key,
      event,
      variant,
      joinUrl,
    });
  }

  async handleNotificationResponse(detectionId, action) {
    debugLogger.info("Notification response", { detectionId, action }, "meeting");
    try {
      const detection = this.activeDetections.get(detectionId);

      if ((action === "start" || action === "join") && detection) {
        if (action === "join") {
          const joinUrl = getMeetingJoinUrl(detection.event);
          if (joinUrl) {
            shell
              .openExternal(joinUrl)
              .catch((error) =>
                debugLogger.error(
                  "Failed to open meeting link",
                  { error: error.message, joinUrl },
                  "meeting"
                )
              );
          }
        }

        const eventSummary = detection.event?.summary || "New note";

        const noteResult = this.databaseManager.saveNote(eventSummary, "", "meeting");
        const meetingsFolder = this.databaseManager.getMeetingsFolder();

        if (!noteResult?.note?.id || !meetingsFolder?.id) {
          debugLogger.error(
            "Meeting note creation failed",
            { noteId: noteResult?.note?.id, folderId: meetingsFolder?.id },
            "meeting"
          );
          return;
        }

        this._consumeNotificationContext(detection.notificationCandidateId);
        this._meetingModeActive = true;

        this.broadcastToWindows("note-added", noteResult.note);

        const isRealEvent =
          detection.event?.calendar_id &&
          detection.event.calendar_id !== "__detected__" &&
          detection.event.calendar_id !== "__manual__";

        if (isRealEvent) {
          const calEvent = this.databaseManager.getCalendarEventById(detection.event.id);
          const updates = { calendar_event_id: detection.event.id };
          if (calEvent?.attendees) {
            updates.participants = calEvent.attendees;
          }
          const updateResult = this.databaseManager.updateNote(noteResult.note.id, updates);
          if (updateResult?.success && updateResult?.note) {
            this.broadcastToWindows("note-updated", updateResult.note);
          }
        }

        await this.windowManager.queueMeetingNoteNavigation({
          noteId: noteResult.note.id,
          folderId: meetingsFolder.id,
          event: detection.event,
          trigger: "calendar-join",
        });
      } else if (action === "dismiss") {
        if (detection?.source === NOTIFICATION_SOURCES.AUDIO) {
          this._dismiss();
        }
      }
    } catch (error) {
      this._meetingModeActive = false;
      debugLogger.error(
        "Error handling notification response",
        { error: error?.message, detectionId, action },
        "meeting"
      );
    } finally {
      // One overlay at a time — a response settles every pending detection,
      // including any the responded prompt replaced.
      this.activeDetections.clear();
      this.windowManager.dismissMeetingNotification();
    }
  }

  async startManualMeeting() {
    debugLogger.info("Starting manual meeting", {}, "meeting");

    const calendarEvent = this._findCalendarEvent();
    if (calendarEvent) {
      return this.joinCalendarMeeting(calendarEvent.id, "hotkey");
    }

    this._meetingModeActive = true;

    const notificationContext = this._findNotificationContext();
    const event = placeholderEvent("__manual__", notificationContext ?? undefined);

    const noteResult = this.databaseManager.saveNote(event.summary, "", "meeting");
    const meetingsFolder = this.databaseManager.getMeetingsFolder();

    if (!noteResult?.note?.id || !meetingsFolder?.id) {
      debugLogger.error(
        "Manual meeting failed — missing note or folder",
        { noteId: noteResult?.note?.id, folderId: meetingsFolder?.id },
        "meeting"
      );
      this._meetingModeActive = false;
      return;
    }

    this._consumeNotificationContext(notificationContext?.id);
    this.broadcastToWindows("note-added", noteResult.note);

    await this.windowManager.queueMeetingNoteNavigation({
      noteId: noteResult.note.id,
      folderId: meetingsFolder.id,
      event,
      trigger: "hotkey",
    });
  }

  async joinCalendarMeeting(eventId, trigger = "calendar-join") {
    this._meetingModeActive = true;
    debugLogger.info("Joining calendar meeting", { eventId, trigger }, "meeting");

    const calEvent = this.databaseManager.getCalendarEventById(eventId);
    if (!calEvent) {
      debugLogger.error("Calendar event not found", { eventId }, "meeting");
      this._meetingModeActive = false;
      return;
    }

    const noteResult = this.databaseManager.saveNote(calEvent.summary || "New note", "", "meeting");
    const meetingsFolder = this.databaseManager.getMeetingsFolder();

    if (!noteResult?.note?.id || !meetingsFolder?.id) {
      debugLogger.error(
        "Join calendar meeting failed — missing note or folder",
        { noteId: noteResult?.note?.id, folderId: meetingsFolder?.id },
        "meeting"
      );
      this._meetingModeActive = false;
      return;
    }

    const updates = { calendar_event_id: calEvent.id };
    if (calEvent.attendees) {
      updates.participants = calEvent.attendees;
    }
    const updateResult = this.databaseManager.updateNote(noteResult.note.id, updates);

    this.broadcastToWindows("note-added", updateResult?.note || noteResult.note);

    await this.windowManager.queueMeetingNoteNavigation({
      noteId: noteResult.note.id,
      folderId: meetingsFolder.id,
      event: calEvent,
      trigger,
    });
  }

  handleNotificationTimeout() {
    // Expiring unanswered is not a decline: only an audio prompt's timeout cools
    // down the mic detector, so an ignored calendar reminder leaves mic detection
    // armed and joining the call late still prompts.
    const audioTimedOut = [...this.activeDetections.values()].some(
      (d) => !d.dismissed && d.source === NOTIFICATION_SOURCES.AUDIO
    );
    if (audioTimedOut) {
      this._dismiss();
    }
    this.activeDetections.clear();
    debugLogger.info(
      "Notification auto-dismissed, detections cleared",
      { audioTimedOut },
      "meeting"
    );
  }

  _flushNotificationQueue() {
    if (this._notificationQueue.length === 0) return;

    if (this._meetingModeActive) {
      debugLogger.info("Dropping queued notifications — meeting mode active", {}, "meeting");
      for (const { source, key } of this._notificationQueue) {
        this.activeDetections.delete(`${source}:${key}`);
      }
      this._notificationQueue = [];
      return;
    }

    debugLogger.info(
      "Flushing notification queue",
      { count: this._notificationQueue.length },
      "meeting"
    );

    let shown = false;
    for (const candidate of this._notificationQueue) {
      const detectionId = `${candidate.source}:${candidate.key}`;
      const detection = this.activeDetections.get(detectionId);
      const allowed = this._notificationsEnabledFor(candidate.source);

      if (!shown && allowed && detection && !detection.dismissed) {
        this._showPrompt(detectionId, candidate.source, candidate.key, candidate.data);
        shown = true;
      } else {
        this.activeDetections.delete(detectionId);
        if (!allowed) {
          debugLogger.info(
            "Queued notification disabled by current preference, dropping",
            { detectionId, source: candidate.source },
            "meeting"
          );
        }
      }
    }

    this._notificationQueue = [];
  }

  _dismiss() {
    this.audioActivityDetector.dismiss();
  }

  setMeetingModeActive(active) {
    this._meetingModeActive = active;
    debugLogger.info("Meeting mode active state changed", { active }, "meeting");
  }

  setUserRecording(active) {
    this._userRecording = active;
    this.audioActivityDetector.setUserRecording(active);

    if (active) {
      if (this._postRecordingCooldown) {
        clearTimeout(this._postRecordingCooldown);
        this._postRecordingCooldown = null;
      }
    } else {
      this._postRecordingCooldown = setTimeout(() => {
        this._postRecordingCooldown = null;
        this._flushNotificationQueue();
      }, 2500);
    }
  }

  setPreferences(prefs) {
    debugLogger.info("Updating detection preferences", prefs, "meeting");
    Object.assign(this.preferences, prefs);

    if (this.preferences.processDetection) {
      this.meetingProcessDetector.start();
    } else {
      this.meetingProcessDetector.stop();
    }

    if (this.preferences.audioDetection) {
      this.audioActivityDetector.start();
    } else {
      this.audioActivityDetector.stop();
    }
  }

  setNotificationContextEnabled(enabled) {
    const nextEnabled = enabled === true;
    if (nextEnabled === this.notificationContextEnabled) return;

    this.notificationContextEnabled = nextEnabled;
    if (!this._started) return;

    if (this.notificationContextEnabled) {
      this.meetingTitleContextProvider?.start?.();
    } else {
      this.meetingTitleContextProvider?.stop?.();
    }
  }

  onWakeFromSleep() {
    if (!this._started || !this.notificationContextEnabled) return false;
    try {
      return this.meetingTitleContextProvider?.reconnect?.() === true;
    } catch {
      debugLogger.warn(
        "Failed to reconnect notification meeting title monitor",
        { failureType: "resume-reconnect", retrying: false },
        "meeting"
      );
      return false;
    }
  }

  getPreferences() {
    return { ...this.preferences };
  }

  start() {
    debugLogger.info("Meeting detection engine started", this.preferences, "meeting");
    this._started = true;
    if (this.preferences.processDetection) this.meetingProcessDetector.start();
    if (this.preferences.audioDetection) {
      this.audioActivityDetector.start();
    }
    if (this.notificationContextEnabled) {
      this.meetingTitleContextProvider?.start?.();
    }
  }

  stop() {
    debugLogger.info("Meeting detection engine stopped", {}, "meeting");
    this.meetingProcessDetector.stop();
    this.audioActivityDetector.stop();
    this.meetingTitleContextProvider?.stop?.();
    this._started = false;
    this.activeDetections.clear();
    this._meetingModeActive = false;
    if (this._postRecordingCooldown) {
      clearTimeout(this._postRecordingCooldown);
      this._postRecordingCooldown = null;
    }
    this._notificationQueue = [];
  }

  broadcastToWindows(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    });
  }
}

module.exports = MeetingDetectionEngine;
