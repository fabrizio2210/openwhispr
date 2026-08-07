const { exec, spawn } = require("child_process");
const { promisify } = require("util");
const path = require("path");
const fs = require("fs");
const EventEmitter = require("events");
const plist = require("plist");
const debugLogger = require("./debugLogger");

const execAsync = promisify(exec);

const CHECK_INTERVAL_MS = process.platform === "win32" ? 15 * 1000 : 3 * 1000;
const SUSTAINED_THRESHOLD_CHECKS = 2;
const SUSTAINED_EVENT_DRIVEN_MS = 2 * 1000;
const COOLDOWN_MS = 5 * 60 * 1000;
const INACTIVE_RESET_MS = 60 * 1000;
const EXEC_OPTS = { timeout: 5000, encoding: "utf8" };
const PIPEWIRE_EXEC_OPTS = { ...EXEC_OPTS, maxBuffer: 4 * 1024 * 1024 };

function getPipeWireInputActivity(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let objects;
  try {
    objects = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(objects)) return null;

  let hasUnknownInputState = false;
  for (const object of objects) {
    if (
      object?.type !== "PipeWire:Interface:Node" ||
      object?.info?.props?.["media.class"] !== "Stream/Input/Audio"
    ) {
      continue;
    }

    if (object.info.state === "running") return true;
    if (object.info.state !== "idle" && object.info.state !== "suspended") {
      hasUnknownInputState = true;
    }
  }

  return hasUnknownInputState ? null : false;
}

function hasRunningPipeWireInputStream(value) {
  return getPipeWireInputActivity(value) === true;
}

function getActivePactlSourceOutputIds(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let sourceOutputs;
  try {
    sourceOutputs = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(sourceOutputs)) return null;

  const activeIds = new Set();
  for (const sourceOutput of sourceOutputs) {
    const id = sourceOutput?.index;
    const corked = sourceOutput?.corked;
    if ((!Number.isInteger(id) && typeof id !== "string") || corked === undefined) {
      return null;
    }

    if (corked === false || corked === 0 || corked === "no") {
      activeIds.add(String(id));
    } else if (corked !== true && corked !== 1 && corked !== "yes") {
      return null;
    }
  }

  return activeIds;
}

function getMacOSAudioEngineActivity(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let engines;
  try {
    engines = plist.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(engines)) return null;

  for (const engine of engines) {
    if (!engine || typeof engine !== "object" || !("IOAudioEngineState" in engine)) return null;
    if (engine.IOAudioEngineState === 1) return true;
    if (engine.IOAudioEngineState !== 0) return null;
  }
  return false;
}

class AudioActivityDetector extends EventEmitter {
  constructor() {
    super();
    this.checkInterval = null;
    this.consecutiveChecks = 0;
    this.audioActiveStart = null;
    this.hasPrompted = false;
    this.lastDismissedAt = null;
    this._userRecording = false;
    this._checking = false;
    this._listenerProcess = null;
    this._activeMicSessions = new Set();
    this._legacyMicSessionCounts = new Map();
    this._windowsSessionStateValid = false;
    this._windowsSessionStateTainted = false;
    this._activeSourceOutputs = new Set();
    this._activeSources = 0;
    this._sustainedTimer = null;
    this._running = false;
    this._eventDriven = false;
    this._eventMicActive = null;
    this._resetTimer = null;
    this._verifiedInactiveSince = null;
    this._inactivityEpoch = 0;
    this._pendingStateObservations = 0;
    this._cooldownExpiryTimer = null;
    this._pactlRefreshGeneration = 0;
    this._startGeneration = 0;
    this._observationGeneration = 0;
    this._execCommand = execAsync;
    this._spawn = spawn;
    this._getProcessList = () => require("./processListCache").getProcessList();
  }

  setUserRecording(active) {
    const wasRecording = this._userRecording;
    this._userRecording = active;
    if (active !== wasRecording) {
      this._observationGeneration++;
      this._pactlRefreshGeneration++;
    }
    if (active) {
      this.consecutiveChecks = 0;
      this.audioActiveStart = null;
      this._clearSustainedTimer();
      this._invalidateVerifiedInactivity();
      this._clearCooldownExpiryTimer();
    } else if (wasRecording && this._eventDriven) {
      if (this._eventMicActive === true) {
        this._onMicStateChanged(true);
      } else if (this._eventMicActive === false && this.hasPrompted) {
        this._startResetTimer();
      }
    }
    debugLogger.debug("User recording state changed", { active }, "meeting");
  }

  async start() {
    if (this._running) return;
    this._running = true;
    const startGeneration = ++this._startGeneration;

    const started = await this._tryEventDriven(startGeneration);
    if (!this._running || startGeneration !== this._startGeneration) return;

    if (started && this._listenerProcess) {
      this._eventDriven = true;
      debugLogger.info(
        "Audio activity detector started (event-driven)",
        { platform: process.platform },
        "meeting"
      );
    } else {
      this._eventDriven = false;
      if (!this.checkInterval) this._startPolling();
      debugLogger.info(
        "Audio activity detector started (polling)",
        { intervalMs: CHECK_INTERVAL_MS, threshold: SUSTAINED_THRESHOLD_CHECKS },
        "meeting"
      );
    }
  }

  stop() {
    if (!this._running) return;
    const preservePromptLatch = this.hasPrompted;
    this._running = false;
    this._startGeneration++;
    this._killListenerProcess();
    this._pactlRefreshGeneration++;
    this._clearSustainedTimer();
    this._clearResetTimer();
    this._clearCooldownExpiryTimer();
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this._reset();
    this.hasPrompted = preservePromptLatch;
    this._eventDriven = false;
    debugLogger.info("Audio activity detector stopped", {}, "meeting");
  }

  dismiss() {
    const preserveResetTimer = Boolean(this._resetTimer);
    this.lastDismissedAt = Date.now();
    this._reset({ preserveSources: true, preserveResetTimer });
    // Keep this continuous activity latched after a dismissal. The detector is
    // re-armed only after sustained inactivity, rather than every cooldown.
    this.hasPrompted = true;
    this._clearSustainedTimer();
    if (!preserveResetTimer && this._eventDriven && this._eventMicActive === false) {
      this._startResetTimer();
    }
    debugLogger.info(
      "Audio detection dismissed, cooldown started",
      { cooldownMs: COOLDOWN_MS },
      "meeting"
    );
  }

  _reset({ preserveSources = false, preserveResetTimer = false } = {}) {
    this.consecutiveChecks = 0;
    this.audioActiveStart = null;
    this.hasPrompted = false;
    if (!preserveSources) {
      this._activeMicSessions.clear();
      this._legacyMicSessionCounts.clear();
      this._windowsSessionStateValid = false;
      this._windowsSessionStateTainted = false;
      this._activeSourceOutputs.clear();
      this._activeSources = 0;
      this._eventMicActive = null;
    }
    if (!preserveResetTimer) this._invalidateVerifiedInactivity();
    this._clearCooldownExpiryTimer();
  }

  _clearSustainedTimer() {
    if (this._sustainedTimer) {
      clearTimeout(this._sustainedTimer);
      this._sustainedTimer = null;
    }
  }

  _startResetTimer() {
    if (!this.hasPrompted) return;
    if (this._verifiedInactiveSince === null) {
      this._verifiedInactiveSince = Date.now();
      this._inactivityEpoch++;
    }
    if (this._resetTimer) return;

    const inactivityEpoch = this._inactivityEpoch;
    const remainingMs = INACTIVE_RESET_MS - (Date.now() - this._verifiedInactiveSince);
    if (remainingMs <= 0) {
      this._completeInactivityReset(inactivityEpoch);
      return;
    }

    this._resetTimer = setTimeout(() => {
      this._resetTimer = null;
      this._completeInactivityReset(inactivityEpoch);
    }, remainingMs);
    this._resetTimer.unref?.();
  }

  _completeInactivityReset(inactivityEpoch) {
    if (
      !this.hasPrompted ||
      this._verifiedInactiveSince === null ||
      inactivityEpoch !== this._inactivityEpoch ||
      this._pendingStateObservations > 0
    ) {
      return false;
    }

    const remainingMs = INACTIVE_RESET_MS - (Date.now() - this._verifiedInactiveSince);
    if (remainingMs > 0) {
      this._startResetTimer();
      return false;
    }

    this.hasPrompted = false;
    this._verifiedInactiveSince = null;
    this._inactivityEpoch++;
    debugLogger.debug("hasPrompted reset after sustained inactivity", {}, "meeting");
    return true;
  }

  _invalidateVerifiedInactivity() {
    this._verifiedInactiveSince = null;
    this._inactivityEpoch++;
    this._clearResetTimer();
  }

  _clearResetTimer() {
    if (this._resetTimer) {
      clearTimeout(this._resetTimer);
      this._resetTimer = null;
    }
  }

  _beginStateObservation() {
    this._pendingStateObservations++;
  }

  _endStateObservation() {
    this._pendingStateObservations = Math.max(0, this._pendingStateObservations - 1);
  }

  _scheduleCooldownExpiryCheck() {
    this._clearCooldownExpiryTimer();
    const remainingMs = Math.max(1, COOLDOWN_MS - (Date.now() - this.lastDismissedAt) + 1);
    this._cooldownExpiryTimer = setTimeout(() => {
      this._cooldownExpiryTimer = null;
      if (this._eventMicActive !== true || this._userRecording || this.hasPrompted) return;

      if (this.lastDismissedAt && Date.now() - this.lastDismissedAt < COOLDOWN_MS) {
        this._scheduleCooldownExpiryCheck();
        return;
      }
      this._onMicStateChanged(true);
    }, remainingMs);
    this._cooldownExpiryTimer.unref?.();
  }

  _clearCooldownExpiryTimer() {
    if (this._cooldownExpiryTimer) {
      clearTimeout(this._cooldownExpiryTimer);
      this._cooldownExpiryTimer = null;
    }
  }

  _killListenerProcess() {
    if (this._listenerProcess) {
      try {
        this._listenerProcess.kill();
      } catch {
        // already exited
      }
      this._listenerProcess = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Event-driven approach
  // ---------------------------------------------------------------------------

  async _tryEventDriven(startGeneration) {
    switch (process.platform) {
      case "darwin":
        return this._tryEventDrivenDarwin(startGeneration);
      case "win32":
        return this._tryEventDrivenWin32(startGeneration);
      case "linux":
        return this._tryEventDrivenLinux(startGeneration);
      default:
        return false;
    }
  }

  _resolveBinary(binaryName) {
    const candidates = [
      path.join(__dirname, "..", "..", "resources", "bin", binaryName),
      path.join(__dirname, "..", "..", "resources", binaryName),
    ];

    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, binaryName),
        path.join(process.resourcesPath, "bin", binaryName),
        path.join(process.resourcesPath, "resources", "bin", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", binaryName)
      );
    }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          fs.accessSync(candidate, fs.constants.X_OK);
          debugLogger.info("Resolved binary", { name: binaryName, path: candidate }, "meeting");
          return candidate;
        }
      } catch {
        // continue
      }
    }
    return null;
  }

  _attachFallbackHandlers(child, label, startGeneration = this._startGeneration) {
    const fallbackToPolling = () => {
      this._fallbackListenerToPolling(child, startGeneration, false);
    };

    child.on("error", (err) => {
      debugLogger.warn(`${label} error`, { error: err.message }, "meeting");
      fallbackToPolling();
    });

    child.on("exit", (code) => {
      debugLogger.warn(`${label} exited`, { code }, "meeting");
      fallbackToPolling();
    });
  }

  _fallbackListenerToPolling(child, startGeneration, terminateChild) {
    if (!this._isCurrentListener(child, startGeneration)) return false;
    this._listenerProcess = null;
    if (terminateChild) {
      try {
        child.kill();
      } catch {
        // already exited
      }
    }
    this._onMicStateUnavailable();
    this._eventDriven = false;
    if (!this.checkInterval) this._startPolling();
    return true;
  }

  _isCurrentListener(child, startGeneration) {
    return (
      this._running && this._listenerProcess === child && this._startGeneration === startGeneration
    );
  }

  _awaitListenerStartup(child, label, startGeneration) {
    return new Promise((resolve) => {
      const handleStartupError = (err) => {
        child.removeListener("spawn", handleSpawn);
        if (this._listenerProcess === child) this._listenerProcess = null;
        debugLogger.warn(`${label} error`, { error: err.message }, "meeting");
        resolve(false);
      };

      const handleSpawn = () => {
        child.removeListener("error", handleStartupError);
        if (!this._isCurrentListener(child, startGeneration)) {
          if (this._listenerProcess === child) this._listenerProcess = null;
          child.kill();
          resolve(false);
          return;
        }
        this._attachFallbackHandlers(child, label, startGeneration);
        resolve(true);
      };

      child.once("error", handleStartupError);
      child.once("spawn", handleSpawn);
    });
  }

  _handleListenerStreamEnd(buffer, invalidateState = true) {
    debugLogger.debug(
      "Mic listener stdout ended",
      { hadPartialOutput: Boolean(buffer.trim()) },
      "meeting"
    );
    if (invalidateState) this._onMicStateUnavailable();
  }

  _attachListenerStreamEndHandler(child, getBuffer, startGeneration = null) {
    child.stdout.on("end", () => {
      if (startGeneration !== null && !this._isCurrentListener(child, startGeneration)) return;
      if (startGeneration !== null) {
        this._handleListenerStreamEnd(getBuffer(), false);
        this._fallbackListenerToPolling(child, startGeneration, true);
      } else {
        this._handleListenerStreamEnd(getBuffer());
      }
    });
  }

  _tryEventDrivenDarwin(startGeneration) {
    const binaryPath = this._resolveBinary("macos-mic-listener");
    if (!binaryPath) {
      debugLogger.warn("macos-mic-listener binary not found, will use polling", {}, "meeting");
      return false;
    }

    try {
      const child = this._spawn(binaryPath, [], { stdio: ["ignore", "pipe", "pipe"] });
      this._listenerProcess = child;

      let buffer = "";
      child.stdout.on("data", (data) => {
        if (!this._isCurrentListener(child, startGeneration)) return;
        buffer += data.toString();
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          this._parseDarwinListenerLine(line);
        }
      });
      this._attachListenerStreamEndHandler(child, () => buffer, startGeneration);

      child.stderr.on("data", (data) => {
        debugLogger.debug(
          "macos-mic-listener stderr",
          { output: data.toString().trim() },
          "meeting"
        );
      });

      return this._awaitListenerStartup(child, "macos-mic-listener", startGeneration);
    } catch (err) {
      debugLogger.warn("Failed to spawn macos-mic-listener", { error: err.message }, "meeting");
      return false;
    }
  }

  _parseDarwinListenerLine(line) {
    if (line === "MIC_ACTIVE") {
      this._onMicStateChanged(true);
    } else if (line === "MIC_INACTIVE") {
      this._onMicStateChanged(false);
    } else if (line) {
      this._onMicStateUnavailable();
    }
  }

  _tryEventDrivenWin32(startGeneration) {
    const binaryPath = this._resolveBinary("windows-mic-listener.exe");
    if (!binaryPath) {
      debugLogger.warn("windows-mic-listener.exe not found, will use polling", {}, "meeting");
      return false;
    }

    try {
      // stdin must be "pipe" — the Windows binary monitors stdin for parent death
      const child = this._spawn(binaryPath, ["--exclude-pid", String(process.pid)], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this._listenerProcess = child;
      this._activeMicSessions.clear();
      this._legacyMicSessionCounts.clear();
      this._windowsSessionStateValid = false;
      this._windowsSessionStateTainted = false;

      let buffer = "";
      child.stdout.on("data", (data) => {
        if (!this._isCurrentListener(child, startGeneration)) return;
        buffer += data.toString();
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          this._parseWin32ListenerLine(line);
        }
      });
      this._attachListenerStreamEndHandler(child, () => buffer, startGeneration);

      child.stderr.on("data", (data) => {
        debugLogger.debug(
          "windows-mic-listener stderr",
          { output: data.toString().trim() },
          "meeting"
        );
      });

      return this._awaitListenerStartup(child, "windows-mic-listener", startGeneration);
    } catch (err) {
      debugLogger.warn("Failed to spawn windows-mic-listener", { error: err.message }, "meeting");
      return false;
    }
  }

  _parseWin32ListenerLine(line) {
    // The native helper emits its initial active sessions before READY. READY
    // confirms enumeration is complete; it must not invalidate that snapshot.
    if (line === "READY") {
      this._windowsSessionStateValid = !this._windowsSessionStateTainted;
      if (this._windowsSessionStateValid) {
        this._onMicStateChanged(
          this._activeMicSessions.size > 0 || this._legacyMicSessionCounts.size > 0
        );
      } else {
        this._onMicStateUnavailable();
      }
      return;
    }

    const startMatch = line.match(/^MIC_START\s+(\d+)(?:\s+(\d+))?$/);
    if (startMatch) {
      const [, pid, sessionId] = startMatch;
      if (sessionId) {
        this._activeMicSessions.add(`${pid}:${sessionId}`);
      } else {
        this._legacyMicSessionCounts.set(pid, (this._legacyMicSessionCounts.get(pid) ?? 0) + 1);
      }
      this._onMicStateChanged(true);
      return;
    }

    const stopMatch = line.match(/^MIC_STOP\s+(\d+)(?:\s+(\d+))?$/);
    if (stopMatch) {
      const [, pid, sessionId] = stopMatch;
      if (sessionId) {
        if (!this._activeMicSessions.delete(`${pid}:${sessionId}`)) {
          this._invalidateWin32ListenerState("unknown session stop");
          return;
        }
      } else {
        const currentCount = this._legacyMicSessionCounts.get(pid);
        if (!currentCount) {
          this._invalidateWin32ListenerState("unknown legacy process stop");
          return;
        }
        const remaining = currentCount - 1;
        if (remaining > 0) {
          this._legacyMicSessionCounts.set(pid, remaining);
        } else {
          this._legacyMicSessionCounts.delete(pid);
        }
      }
      if (this._activeMicSessions.size === 0 && this._legacyMicSessionCounts.size === 0) {
        if (this._windowsSessionStateValid) {
          this._onMicStateChanged(false);
        } else {
          this._onMicStateUnavailable();
        }
      }
      return;
    }

    if (line) {
      this._invalidateWin32ListenerState("malformed listener message");
    }
  }

  _invalidateWin32ListenerState(reason) {
    this._windowsSessionStateValid = false;
    this._windowsSessionStateTainted = true;

    // Legacy helpers may report one stop when a session becomes inactive and
    // another when it disconnects. Once event accounting disagrees with the
    // helper, no later delta can prove that the microphone is inactive. Drop
    // the inconsistent stream and let polling establish a fresh full state.
    const child = this._listenerProcess;
    const startGeneration = this._startGeneration;
    if (child && this._isCurrentListener(child, startGeneration)) {
      debugLogger.warn(
        "Windows mic listener state invalid, falling back to polling",
        { reason },
        "meeting"
      );
      this._fallbackListenerToPolling(child, startGeneration, true);
      return;
    }

    this._onMicStateUnavailable();
  }

  _tryEventDrivenLinux(startGeneration) {
    return new Promise((resolve) => {
      try {
        const child = this._spawn("pactl", ["subscribe"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        this._listenerProcess = child;

        let buffer = "";
        let startupReady = false;
        let startupEventObserved = false;
        child.stdout.on("data", (data) => {
          if (!this._isCurrentListener(child, startGeneration)) return;
          buffer += data.toString();
          let newlineIdx;
          while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!startupReady) {
              if (line.includes("source-output")) startupEventObserved = true;
              continue;
            }
            void this._parsePactlSubscribeLine(line);
          }
        });
        this._attachListenerStreamEndHandler(child, () => buffer, startGeneration);

        const handleStartupError = (err) => {
          child.removeListener("spawn", handleSpawn);
          if (this._listenerProcess === child) {
            this._listenerProcess = null;
          }
          debugLogger.warn("pactl subscribe error", { error: err.message }, "meeting");
          resolve(false);
        };

        const handleSpawn = async () => {
          child.removeListener("error", handleStartupError);
          if (!this._running || startGeneration !== this._startGeneration) {
            if (this._listenerProcess === child) {
              this._listenerProcess = null;
            }
            child.kill();
            resolve(false);
            return;
          }
          this._attachFallbackHandlers(child, "pactl subscribe", startGeneration);
          let initialSnapshot;
          do {
            startupEventObserved = false;
            initialSnapshot = await this._refreshPactlSourceOutputs();
            if (!this._isCurrentListener(child, startGeneration)) {
              resolve(false);
              return;
            }
          } while (startupEventObserved);

          if (initialSnapshot === null) {
            this._listenerProcess = null;
            child.kill();
            resolve(false);
            return;
          }
          startupReady = true;
          resolve(true);
        };

        child.once("error", handleStartupError);
        child.once("spawn", handleSpawn);
      } catch (err) {
        debugLogger.warn("pactl subscribe error", { error: err.message }, "meeting");
        resolve(false);
      }
    });
  }

  _parsePactlSubscribeLine(line) {
    if (!/Event\s+'(?:new|change|remove)'\s+on\s+source-output\s+#\d+/i.test(line)) {
      if (line.includes("source-output")) this._onMicStateUnavailable();
      return null;
    }
    // A valid stream event means the previously observed inactive state may
    // already be stale. The full snapshot below establishes the new state.
    this._invalidateVerifiedInactivity();
    return this._refreshPactlSourceOutputs();
  }

  async _refreshPactlSourceOutputs() {
    const refreshGeneration = ++this._pactlRefreshGeneration;
    const startGeneration = this._startGeneration;
    const observationGeneration = this._observationGeneration;
    this._beginStateObservation();
    let snapshot;
    try {
      snapshot = await this._getLinuxCaptureSnapshot();
    } finally {
      this._endStateObservation();
    }
    if (
      !this._running ||
      refreshGeneration !== this._pactlRefreshGeneration ||
      startGeneration !== this._startGeneration ||
      observationGeneration !== this._observationGeneration
    ) {
      return null;
    }
    if (snapshot === null) {
      const listener = this._listenerProcess;
      if (this._eventDriven && listener && this._isCurrentListener(listener, startGeneration)) {
        this._fallbackListenerToPolling(listener, startGeneration, true);
      } else {
        this._onMicStateUnavailable();
      }
      return null;
    }

    if (snapshot.sourceIds) {
      this._activeSourceOutputs = new Set(snapshot.sourceIds);
      this._activeSources = this._activeSourceOutputs.size;
    } else if (!snapshot.active) {
      this._activeSourceOutputs.clear();
      this._activeSources = 0;
    } else if (this._activeSources === 0) {
      // pw-dump proves activity but does not expose PulseAudio source-output IDs.
      this._activeSources = 1;
    }
    this._onMicStateChanged(snapshot.active);
    return snapshot.active;
  }

  // ---------------------------------------------------------------------------
  // Shared event-driven handler
  // ---------------------------------------------------------------------------

  _onMicStateUnavailable() {
    this._pactlRefreshGeneration++;
    this.consecutiveChecks = 0;
    this.audioActiveStart = null;
    this._eventMicActive = null;
    this._clearSustainedTimer();
    this._invalidateVerifiedInactivity();
    this._clearCooldownExpiryTimer();
    debugLogger.debug("Mic state unavailable", {}, "meeting");
  }

  _onMicStateChanged(active) {
    this._eventMicActive = active;
    if (active) this._invalidateVerifiedInactivity();
    if (!active) this._clearCooldownExpiryTimer();

    if (this._userRecording) {
      debugLogger.debug("Mic state changed but user recording, ignoring", { active }, "meeting");
      return;
    }
    if (this.lastDismissedAt && Date.now() - this.lastDismissedAt < COOLDOWN_MS) {
      if (active) {
        if (this.hasPrompted) {
          this._clearCooldownExpiryTimer();
        } else {
          this._scheduleCooldownExpiryCheck();
        }
      } else {
        this._clearSustainedTimer();
        this.audioActiveStart = null;
        if (this.hasPrompted) this._startResetTimer();
      }
      debugLogger.debug(
        "Mic state changed but in cooldown",
        {
          active,
          remainingMs: COOLDOWN_MS - (Date.now() - this.lastDismissedAt),
        },
        "meeting"
      );
      return;
    }

    this._clearCooldownExpiryTimer();

    debugLogger.debug(
      "Mic state changed (event-driven)",
      { active, hasPrompted: this.hasPrompted },
      "meeting"
    );

    if (active) {
      if (this.hasPrompted) {
        debugLogger.debug("Mic active but already prompted, suppressing", {}, "meeting");
        return;
      }
      if (!this.audioActiveStart) this.audioActiveStart = Date.now();

      if (!this._sustainedTimer) {
        const startGeneration = this._startGeneration;
        this._sustainedTimer = setTimeout(() => {
          this._sustainedTimer = null;
          if (!this._running || startGeneration !== this._startGeneration) return;
          if (this._userRecording || this.hasPrompted) return;
          if (this.lastDismissedAt && Date.now() - this.lastDismissedAt < COOLDOWN_MS) return;

          this.hasPrompted = true;
          const now = Date.now();
          const durationMs = now - this.audioActiveStart;
          debugLogger.info(
            "Sustained audio activity detected (event-driven)",
            { durationMs },
            "meeting"
          );
          this.emit("sustained-audio-detected", { durationMs, detectedAt: now });
        }, SUSTAINED_EVENT_DRIVEN_MS);
      }
    } else {
      this._clearSustainedTimer();
      this.audioActiveStart = null;
      if (this.hasPrompted) this._startResetTimer();
    }
  }

  // ---------------------------------------------------------------------------
  // Polling fallback
  // ---------------------------------------------------------------------------

  _startPolling() {
    this._check();
    this.checkInterval = setInterval(() => this._check(), CHECK_INTERVAL_MS);
  }

  async _check() {
    if (this._checking) return;
    if (this._userRecording) return;

    const startGeneration = this._startGeneration;
    const observationGeneration = this._observationGeneration;
    this._checking = true;
    this._beginStateObservation();
    let observationFinished = false;
    try {
      const active = await this._isMicActive();
      this._endStateObservation();
      observationFinished = true;
      if (
        !this._running ||
        startGeneration !== this._startGeneration ||
        observationGeneration !== this._observationGeneration ||
        this._userRecording
      ) {
        return;
      }
      if (active !== true && active !== false) {
        // An unavailable snapshot is neither evidence of activity nor of
        // inactivity. Break activation progress and require a fresh full
        // inactivity interval before re-arming a dismissed prompt.
        this._onMicStateUnavailable();
        return;
      }

      const inCooldown = this.lastDismissedAt && Date.now() - this.lastDismissedAt < COOLDOWN_MS;
      if (inCooldown) {
        if (active) {
          this._invalidateVerifiedInactivity();
        } else {
          this.consecutiveChecks = 0;
          this.audioActiveStart = null;
          if (this.hasPrompted) this._startResetTimer();
        }
        return;
      }

      debugLogger.debug(
        "Mic check",
        { active, consecutiveChecks: this.consecutiveChecks },
        "meeting"
      );

      if (active) {
        this._invalidateVerifiedInactivity();
        this.consecutiveChecks++;
        if (!this.audioActiveStart) this.audioActiveStart = Date.now();

        if (!this.hasPrompted && this.consecutiveChecks >= SUSTAINED_THRESHOLD_CHECKS) {
          this.hasPrompted = true;
          const now = Date.now();
          const durationMs = now - this.audioActiveStart;
          debugLogger.info(
            "Sustained audio activity detected",
            { consecutiveChecks: this.consecutiveChecks, durationMs },
            "meeting"
          );
          this.emit("sustained-audio-detected", { durationMs, detectedAt: now });
        }
      } else {
        if (this.consecutiveChecks > 0) {
          debugLogger.debug(
            "Mic activity reset",
            { previousChecks: this.consecutiveChecks },
            "meeting"
          );
        }
        this.consecutiveChecks = 0;
        this.audioActiveStart = null;
        if (this.hasPrompted) this._startResetTimer();
      }
    } finally {
      if (!observationFinished) this._endStateObservation();
      this._checking = false;
    }
  }

  async _isMicActive() {
    switch (process.platform) {
      case "darwin":
        return this._checkDarwin();
      case "win32":
        return this._checkWin32();
      case "linux":
        return this._checkLinux();
      default:
        return false;
    }
  }

  async _checkDarwin() {
    try {
      const { stdout } = await this._execCommand("ioreg -a -l -w 0 -c IOAudioEngine", EXEC_OPTS);
      return getMacOSAudioEngineActivity(stdout);
    } catch {
      return null;
    }
  }

  async _checkWin32() {
    try {
      const names = await this._getProcessList();
      return (
        names.includes("cpthost.exe") ||
        names.includes("ms-teams_modulehost.exe") ||
        names.includes("webexmeetingsapp.exe")
      );
    } catch {
      return null;
    }
  }

  async _getLinuxCaptureSnapshot() {
    try {
      const { stdout } = await this._execCommand(
        "pactl -f json list source-outputs",
        PIPEWIRE_EXEC_OPTS
      );
      const sourceIds = getActivePactlSourceOutputIds(stdout);
      if (sourceIds !== null) {
        return { active: sourceIds.size > 0, sourceIds };
      }
    } catch {
      // pactl unavailable or too old for JSON output; try native PipeWire state.
    }

    try {
      const { stdout } = await this._execCommand("pw-dump", PIPEWIRE_EXEC_OPTS);
      const active = getPipeWireInputActivity(stdout);
      return active === null ? null : { active, sourceIds: null };
    } catch {
      return null;
    }
  }

  async _checkLinux() {
    const snapshot = await this._getLinuxCaptureSnapshot();
    return snapshot?.active ?? null;
  }
}

module.exports = AudioActivityDetector;
module.exports.getActivePactlSourceOutputIds = getActivePactlSourceOutputIds;
module.exports.getMacOSAudioEngineActivity = getMacOSAudioEngineActivity;
module.exports.getPipeWireInputActivity = getPipeWireInputActivity;
module.exports.hasRunningPipeWireInputStream = hasRunningPipeWireInputStream;
