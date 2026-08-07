const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");

const AudioActivityDetector = require("../../src/helpers/audioActivityDetector");
const { ProcessListCache } = require("../../src/helpers/processListCache");
const {
  getActivePactlSourceOutputIds,
  getMacOSAudioEngineActivity,
  getPipeWireInputActivity,
  hasRunningPipeWireInputStream,
} = AudioActivityDetector;

function pipeWireNode({ state, mediaClass = "Stream/Input/Audio" }) {
  return {
    id: 42,
    type: "PipeWire:Interface:Node",
    info: {
      state,
      props: { "media.class": mediaClass },
    },
  };
}

function linuxSnapshot(activeIds) {
  const sourceIds = new Set(activeIds.map(String));
  return { active: sourceIds.size > 0, sourceIds };
}

function cleanupDetector(detector) {
  detector._clearSustainedTimer();
  detector._clearResetTimer();
  detector._clearCooldownExpiryTimer();
}

function fakeListenerProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("PipeWire fallback accepts only running microphone input streams", () => {
  assert.equal(
    hasRunningPipeWireInputStream(JSON.stringify([pipeWireNode({ state: "running" })])),
    true
  );
  assert.equal(
    hasRunningPipeWireInputStream(JSON.stringify([pipeWireNode({ state: "suspended" })])),
    false
  );
  assert.equal(
    hasRunningPipeWireInputStream(JSON.stringify([pipeWireNode({ state: "idle" })])),
    false
  );
  assert.equal(
    hasRunningPipeWireInputStream(
      JSON.stringify([pipeWireNode({ state: "running", mediaClass: "Audio/Source" })])
    ),
    false
  );
  assert.equal(hasRunningPipeWireInputStream("not JSON"), false);
});

test("PipeWire fallback distinguishes an unavailable snapshot from inactivity", () => {
  assert.equal(getPipeWireInputActivity("not JSON"), null);
  assert.equal(getPipeWireInputActivity(JSON.stringify({})), null);
  assert.equal(getPipeWireInputActivity(JSON.stringify([])), false);
  assert.equal(
    getPipeWireInputActivity(JSON.stringify([pipeWireNode({ state: undefined })])),
    null
  );
});

test("PulseAudio snapshots count only uncorked source outputs", () => {
  const activeIds = getActivePactlSourceOutputIds(
    JSON.stringify([
      { index: 11, corked: false },
      { index: 22, corked: true },
      { index: "33", corked: "no" },
      { index: 44, corked: "yes" },
    ])
  );

  assert.deepEqual([...activeIds], ["11", "33"]);
  assert.equal(getActivePactlSourceOutputIds(JSON.stringify([{ index: 11 }])), null);
  assert.equal(getActivePactlSourceOutputIds("not JSON"), null);
});

test("macOS polling accepts only structured IOAudioEngine snapshots", () => {
  const plist = (body) => `<?xml version="1.0"?><plist><array>${body}</array></plist>`;

  assert.equal(getMacOSAudioEngineActivity(plist("")), false);
  assert.equal(
    getMacOSAudioEngineActivity(
      plist("<dict><key>IOAudioEngineState</key><integer>0</integer></dict>")
    ),
    false
  );
  assert.equal(
    getMacOSAudioEngineActivity(
      plist("<dict><key>IOAudioEngineState</key><integer>1</integer></dict>")
    ),
    true
  );
  assert.equal(getMacOSAudioEngineActivity(""), null);
  assert.equal(getMacOSAudioEngineActivity("truncated ioreg output"), null);
  assert.equal(getMacOSAudioEngineActivity(plist("<dict></dict>")), null);
  assert.equal(
    getMacOSAudioEngineActivity(
      "<plist><array><dict><key>IOAudioEngineState</key><integer>0</integer></array></plist>"
    ),
    null
  );
});

test("Linux polling uses cork state even when pactl is installed", async () => {
  const detector = new AudioActivityDetector();
  const commands = [];
  detector._execCommand = async (command) => {
    commands.push(command);
    return { stdout: JSON.stringify([{ index: 11, corked: true }]) };
  };

  assert.equal(await detector._checkLinux(), false);
  assert.deepEqual(commands, ["pactl -f json list source-outputs"]);

  detector._execCommand = async () => ({
    stdout: JSON.stringify([{ index: 11, corked: false }]),
  });
  assert.equal(await detector._checkLinux(), true);
});

test("dismissal latches a prompt until sustained inactivity", async (t) => {
  const detector = new AudioActivityDetector();
  detector._running = true;
  t.after(() => detector._clearResetTimer());

  detector.hasPrompted = true;
  detector.consecutiveChecks = 5;
  detector.dismiss();

  assert.equal(detector.hasPrompted, true);
  assert.equal(detector.consecutiveChecks, 0);
  assert.equal(typeof detector.lastDismissedAt, "number");

  detector._isMicActive = async () => false;
  await detector._check();
  const resetTimer = detector._resetTimer;
  assert.ok(resetTimer);

  await detector._check();
  assert.equal(
    detector._resetTimer,
    resetTimer,
    "repeated inactive polls must not restart the timer"
  );
});

test("continued activity during cooldown keeps the dismissed prompt latched", async (t) => {
  const detector = new AudioActivityDetector();
  detector._running = true;
  t.after(() => detector._clearResetTimer());

  detector.dismiss();
  detector._startResetTimer();
  assert.ok(detector._resetTimer);

  detector._isMicActive = async () => true;
  await detector._check();

  assert.equal(detector.hasPrompted, true);
  assert.equal(detector._resetTimer, null);
  assert.equal(detector.consecutiveChecks, 0);
});

test("a pending polling observation blocks inactivity re-arming at the timer boundary", async (t) => {
  for (const [label, result] of [
    ["active", true],
    ["unavailable", null],
  ]) {
    await t.test(label, async () => {
      const detector = new AudioActivityDetector();
      const observation = deferred();
      t.after(() => cleanupDetector(detector));
      detector._running = true;
      detector.dismiss();
      detector._startResetTimer();
      detector._clearResetTimer();
      detector._verifiedInactiveSince = Date.now() - 61_000;
      const inactivityEpoch = detector._inactivityEpoch;
      detector._isMicActive = () => observation.promise;

      const check = detector._check();
      assert.equal(detector._pendingStateObservations, 1);
      assert.equal(detector._completeInactivityReset(inactivityEpoch), false);
      assert.equal(detector.hasPrompted, true);

      observation.resolve(result);
      await check;

      assert.equal(detector.hasPrompted, true);
      assert.equal(detector._verifiedInactiveSince, null);
      assert.equal(detector._resetTimer, null);
    });
  }
});

test("a PulseAudio event immediately invalidates verified inactivity before refresh", async (t) => {
  const detector = new AudioActivityDetector();
  const snapshot = deferred();
  t.after(() => cleanupDetector(detector));
  detector._running = true;
  detector._eventDriven = true;
  detector.dismiss();
  detector._onMicStateChanged(false);
  assert.ok(detector._resetTimer);
  const inactivityEpoch = detector._inactivityEpoch;
  detector._getLinuxCaptureSnapshot = () => snapshot.promise;

  const refresh = detector._parsePactlSubscribeLine("Event 'change' on source-output #11");

  assert.equal(detector._verifiedInactiveSince, null);
  assert.equal(detector._resetTimer, null);
  assert.equal(detector._completeInactivityReset(inactivityEpoch), false);
  assert.equal(detector.hasPrompted, true);

  snapshot.resolve(null);
  await refresh;
  assert.equal(detector.hasPrompted, true);
});

test("starting a user recording cancels partial inactivity re-arming", async (t) => {
  const detector = new AudioActivityDetector();
  detector._running = true;
  t.after(() => cleanupDetector(detector));

  detector.dismiss();
  detector._isMicActive = async () => false;
  await detector._check();
  assert.ok(detector._resetTimer);

  detector.setUserRecording(true);
  assert.equal(detector._resetTimer, null);
  detector.setUserRecording(false);

  assert.equal(detector.hasPrompted, true);
  assert.equal(detector._resetTimer, null);
});

test("ending user recording restarts verified event-driven inactivity", (t) => {
  const detector = new AudioActivityDetector();
  t.after(() => cleanupDetector(detector));
  detector._eventDriven = true;
  detector.hasPrompted = true;

  detector.setUserRecording(true);
  detector._onMicStateChanged(false);
  assert.equal(detector._resetTimer, null);

  detector.setUserRecording(false);

  assert.ok(detector._resetTimer);
  assert.equal(detector.hasPrompted, true);
});

test("ending user recording replays verified event-driven activity", (t) => {
  const detector = new AudioActivityDetector();
  t.after(() => cleanupDetector(detector));
  detector._running = true;
  detector._eventDriven = true;

  detector.setUserRecording(true);
  detector._onMicStateChanged(true);
  assert.equal(detector._sustainedTimer, null);

  detector.setUserRecording(false);

  assert.equal(detector._eventMicActive, true);
  assert.ok(detector._sustainedTimer);
});

test("continued activity does not emit another prompt after the cooldown expires", async (t) => {
  const detector = new AudioActivityDetector();
  detector._running = true;
  t.after(() => detector._clearResetTimer());
  let detectionCount = 0;
  detector.on("sustained-audio-detected", () => {
    detectionCount += 1;
  });

  detector.dismiss();
  detector.lastDismissedAt = Date.now() - 10 * 60 * 1000;
  detector._isMicActive = async () => true;

  await detector._check();
  await detector._check();

  assert.equal(detector.hasPrompted, true);
  assert.equal(detectionCount, 0);
});

test("stop and restart preserve a dismissed continuous-activity latch", (t) => {
  const detector = new AudioActivityDetector();
  t.after(() => cleanupDetector(detector));
  let detectionCount = 0;
  detector.on("sustained-audio-detected", () => {
    detectionCount += 1;
  });
  detector._running = true;
  detector._eventDriven = true;
  detector.dismiss();

  detector.stop();
  assert.equal(detector.hasPrompted, true);

  detector._running = true;
  detector._startGeneration++;
  detector.lastDismissedAt = Date.now() - 10 * 60 * 1000;
  detector._onMicStateChanged(true);

  assert.equal(detector.hasPrompted, true);
  assert.equal(detector._sustainedTimer, null);
  assert.equal(detectionCount, 0);
});

test("polling command failures do not re-arm a dismissed prompt", async (t) => {
  const detector = new AudioActivityDetector();
  detector._running = true;
  t.after(() => detector._clearResetTimer());
  detector._execCommand = async () => {
    throw new Error("command unavailable");
  };
  detector._isMicActive = () => detector._checkLinux();

  detector.dismiss();
  detector._startResetTimer();
  assert.ok(detector._resetTimer);

  await detector._check();

  assert.equal(detector.hasPrompted, true);
  assert.equal(detector._resetTimer, null);
});

test("macOS polling failures do not re-arm a dismissed prompt", async (t) => {
  const detector = new AudioActivityDetector();
  detector._running = true;
  t.after(() => cleanupDetector(detector));
  detector._execCommand = async () => {
    throw new Error("ioreg unavailable");
  };
  detector._isMicActive = () => detector._checkDarwin();

  detector.dismiss();
  detector._startResetTimer();
  await detector._check();

  assert.equal(await detector._checkDarwin(), null);
  assert.equal(detector.hasPrompted, true);
  assert.equal(detector._resetTimer, null);
});

test("malformed successful macOS polling output does not re-arm a dismissed prompt", async (t) => {
  const detector = new AudioActivityDetector();
  detector._running = true;
  t.after(() => cleanupDetector(detector));
  detector._execCommand = async () => ({ stdout: "truncated ioreg output" });
  detector._isMicActive = () => detector._checkDarwin();

  detector.dismiss();
  detector._startResetTimer();
  await detector._check();

  assert.equal(await detector._checkDarwin(), null);
  assert.equal(detector.hasPrompted, true);
  assert.equal(detector._resetTimer, null);
});

test("Windows polling failures do not re-arm a dismissed prompt", async (t) => {
  const detector = new AudioActivityDetector();
  detector._running = true;
  t.after(() => cleanupDetector(detector));
  const processListCache = new ProcessListCache(async () => ({
    default: async () => {
      throw new Error("process list unavailable");
    },
  }));
  detector._getProcessList = () => processListCache.getProcessList();
  detector._isMicActive = () => detector._checkWin32();

  detector.dismiss();
  detector._startResetTimer();
  await detector._check();

  assert.equal(await detector._checkWin32(), null);
  assert.equal(detector.hasPrompted, true);
  assert.equal(detector._resetTimer, null);
});

test("an unavailable Linux event snapshot cancels stale state timers", async (t) => {
  const detector = new AudioActivityDetector();
  detector._running = true;
  t.after(() => cleanupDetector(detector));

  detector.hasPrompted = true;
  detector._onMicStateChanged(false);
  assert.ok(detector._resetTimer);
  detector._getLinuxCaptureSnapshot = async () => null;
  await detector._refreshPactlSourceOutputs();
  assert.equal(detector._resetTimer, null);

  detector.hasPrompted = false;
  detector._onMicStateChanged(true);
  assert.ok(detector._sustainedTimer);
  await detector._refreshPactlSourceOutputs();
  assert.equal(detector._sustainedTimer, null);
  assert.equal(detector._eventMicActive, null);
});

test("stale Linux snapshots are discarded after observation invalidation", async (t) => {
  for (const [label, invalidate] of [
    ["listener failure", (detector) => detector._onMicStateUnavailable()],
    [
      "user recording transition",
      (detector) => {
        detector.setUserRecording(true);
        detector.setUserRecording(false);
      },
    ],
  ]) {
    await t.test(label, async () => {
      const detector = new AudioActivityDetector();
      const snapshot = deferred();
      detector._running = true;
      detector._startGeneration = 3;
      detector.hasPrompted = true;
      detector._getLinuxCaptureSnapshot = () => snapshot.promise;

      const refresh = detector._refreshPactlSourceOutputs();
      invalidate(detector);
      snapshot.resolve(linuxSnapshot([]));

      assert.equal(await refresh, null);
      assert.equal(detector._eventMicActive, null);
      assert.equal(detector._resetTimer, null);
      cleanupDetector(detector);
    });
  }
});

test("malformed native listener messages cancel stale state timers", (t) => {
  const darwinDetector = new AudioActivityDetector();
  const linuxDetector = new AudioActivityDetector();
  const windowsDetector = new AudioActivityDetector();
  t.after(() => {
    cleanupDetector(darwinDetector);
    cleanupDetector(linuxDetector);
    cleanupDetector(windowsDetector);
  });

  darwinDetector.hasPrompted = true;
  darwinDetector._onMicStateChanged(false);
  assert.ok(darwinDetector._resetTimer);
  darwinDetector._parseDarwinListenerLine("MIC_UNKNOWN");
  assert.equal(darwinDetector._resetTimer, null);

  linuxDetector.hasPrompted = true;
  linuxDetector._onMicStateChanged(false);
  assert.ok(linuxDetector._resetTimer);
  linuxDetector._parsePactlSubscribeLine("Event 'change' on source-output invalid");
  assert.equal(linuxDetector._resetTimer, null);

  windowsDetector._onMicStateChanged(true);
  assert.ok(windowsDetector._sustainedTimer);
  windowsDetector._parseWin32ListenerLine("MIC_START invalid");
  assert.equal(windowsDetector._sustainedTimer, null);

  windowsDetector._onMicStateChanged(true);
  assert.ok(windowsDetector._sustainedTimer);
  windowsDetector._handleListenerStreamEnd("MIC");
  assert.equal(windowsDetector._sustainedTimer, null);
});

test("Windows READY preserves microphone sessions found during startup", (t) => {
  const detector = new AudioActivityDetector();
  t.after(() => cleanupDetector(detector));

  detector._parseWin32ListenerLine("MIC_START 101 7");
  const sustainedTimer = detector._sustainedTimer;
  assert.ok(sustainedTimer);

  detector._parseWin32ListenerLine("READY");

  assert.equal(detector._eventMicActive, true);
  assert.equal(detector._sustainedTimer, sustainedTimer);
  assert.deepEqual([...detector._activeMicSessions], ["101:7"]);
});

test("unknown Windows stops invalidate state instead of proving inactivity", (t) => {
  for (const stopLine of ["MIC_STOP 101 99", "MIC_STOP 202"]) {
    const detector = new AudioActivityDetector();
    t.after(() => cleanupDetector(detector));
    detector.hasPrompted = true;
    detector._onMicStateChanged(false);
    assert.ok(detector._resetTimer);

    detector._parseWin32ListenerLine(stopLine);

    assert.equal(detector._eventMicActive, null);
    assert.equal(detector._resetTimer, null);
    assert.equal(detector.hasPrompted, true);
  }
});

test("tainted Windows session accounting cannot later prove inactivity", (t) => {
  const detector = new AudioActivityDetector();
  t.after(() => cleanupDetector(detector));
  detector.hasPrompted = true;
  detector._parseWin32ListenerLine("MIC_START 101 7");
  detector._parseWin32ListenerLine("READY");
  detector._clearSustainedTimer();

  detector._parseWin32ListenerLine("MIC_STOP 101 99");
  assert.equal(detector._windowsSessionStateValid, false);
  assert.equal(detector._windowsSessionStateTainted, true);

  detector._parseWin32ListenerLine("MIC_STOP 101 7");

  assert.equal(detector._eventMicActive, null);
  assert.equal(detector._resetTimer, null);
  assert.equal(detector.hasPrompted, true);
});

test("duplicate legacy Windows stops fall back to a fresh polling snapshot", (t) => {
  const detector = new AudioActivityDetector();
  const child = fakeListenerProcess();
  let pollingStarts = 0;
  t.after(() => cleanupDetector(detector));
  detector._running = true;
  detector._eventDriven = true;
  detector._startGeneration = 4;
  detector._listenerProcess = child;
  detector._startPolling = () => {
    pollingStarts += 1;
  };

  detector._parseWin32ListenerLine("MIC_START 101");
  detector._parseWin32ListenerLine("READY");
  detector._clearSustainedTimer();
  detector.hasPrompted = true;
  detector._parseWin32ListenerLine("MIC_STOP 101");
  assert.ok(detector._resetTimer);

  detector._parseWin32ListenerLine("MIC_STOP 101");

  assert.equal(child.killed, true);
  assert.equal(detector._listenerProcess, null);
  assert.equal(detector._eventDriven, false);
  assert.equal(pollingStarts, 1);
  assert.equal(detector._eventMicActive, null);
  assert.equal(detector._resetTimer, null);
  assert.equal(detector.hasPrompted, true);
});

test("native listener startup errors fall back to polling", async (t) => {
  for (const [label, method, binaryPath] of [
    ["macOS", "_tryEventDrivenDarwin", "/fake/macos-mic-listener"],
    ["Windows", "_tryEventDrivenWin32", "/fake/windows-mic-listener.exe"],
  ]) {
    await t.test(label, async () => {
      const detector = new AudioActivityDetector();
      const child = fakeListenerProcess();
      let pollingStarts = 0;
      detector._resolveBinary = () => binaryPath;
      detector._spawn = () => child;
      detector._tryEventDriven = (generation) => detector[method](generation);
      detector._startPolling = () => {
        pollingStarts += 1;
      };

      const startPromise = detector.start();
      child.emit("error", new Error("cannot execute helper"));
      await startPromise;

      assert.equal(detector._listenerProcess, null);
      assert.equal(detector._eventDriven, false);
      assert.equal(pollingStarts, 1);
      detector.stop();
    });
  }
});

test("an unavailable initial Linux snapshot falls back to polling", async () => {
  const detector = new AudioActivityDetector();
  const child = fakeListenerProcess();
  let pollingStarts = 0;
  detector._spawn = () => child;
  detector._getLinuxCaptureSnapshot = async () => null;
  detector._tryEventDriven = (generation) => detector._tryEventDrivenLinux(generation);
  detector._startPolling = () => {
    pollingStarts += 1;
  };

  const startPromise = detector.start();
  child.emit("spawn");
  await startPromise;

  assert.equal(child.killed, true);
  assert.equal(detector._listenerProcess, null);
  assert.equal(detector._eventDriven, false);
  assert.equal(pollingStarts, 1);
  detector.stop();
});

test("an unavailable runtime Linux snapshot falls back to polling", async () => {
  const detector = new AudioActivityDetector();
  const child = fakeListenerProcess();
  let pollingStarts = 0;
  detector._running = true;
  detector._eventDriven = true;
  detector._startGeneration = 4;
  detector._listenerProcess = child;
  detector._getLinuxCaptureSnapshot = async () => null;
  detector._startPolling = () => {
    pollingStarts += 1;
  };

  assert.equal(await detector._refreshPactlSourceOutputs(), null);

  assert.equal(child.killed, true);
  assert.equal(detector._listenerProcess, null);
  assert.equal(detector._eventDriven, false);
  assert.equal(pollingStarts, 1);
  detector.stop();
});

test("buffered Windows listener output cannot reactivate a stopped detector", async (t) => {
  const detector = new AudioActivityDetector();
  const child = fakeListenerProcess();
  t.after(() => cleanupDetector(detector));
  detector._resolveBinary = () => "/fake/windows-mic-listener.exe";
  detector._spawn = () => child;
  detector._running = true;
  detector._startGeneration = 4;

  const startup = detector._tryEventDrivenWin32(4);
  child.emit("spawn");
  assert.equal(await startup, true);
  detector.stop();
  child.stdout.emit("data", Buffer.from("MIC_START 101 7\n"));

  assert.equal(child.killed, true);
  assert.equal(detector._sustainedTimer, null);
  assert.equal(detector._eventMicActive, null);
  assert.equal(detector._activeMicSessions.size, 0);
});

test("in-flight polling results are discarded across stop and restart", async () => {
  const detector = new AudioActivityDetector();
  const result = deferred();
  detector._running = true;
  detector._startGeneration = 4;
  detector._isMicActive = () => result.promise;

  const check = detector._check();
  detector.stop();
  detector._running = true;
  detector._startGeneration++;
  result.resolve(true);
  await check;

  assert.equal(detector.consecutiveChecks, 0);
  assert.equal(detector.audioActiveStart, null);
  assert.equal(detector.hasPrompted, false);
});

test("in-flight polling results are discarded across user recording transitions", async () => {
  const detector = new AudioActivityDetector();
  const result = deferred();
  detector._running = true;
  detector._startGeneration = 4;
  detector._isMicActive = () => result.promise;

  const check = detector._check();
  detector.setUserRecording(true);
  detector.setUserRecording(false);
  result.resolve(true);
  await check;

  assert.equal(detector.consecutiveChecks, 0);
  assert.equal(detector.audioActiveStart, null);
  assert.equal(detector.hasPrompted, false);
});

test("listener error and exit fallbacks invalidate stale state", async (t) => {
  for (const eventName of ["error", "exit"]) {
    await t.test(eventName, () => {
      const detector = new AudioActivityDetector();
      const child = new EventEmitter();
      detector._listenerProcess = child;
      detector._running = true;
      detector._eventDriven = true;
      detector._startPolling = () => {};
      detector._onMicStateChanged(true);
      assert.ok(detector._sustainedTimer);
      detector._attachFallbackHandlers(child, "test-listener");

      child.emit(eventName, eventName === "error" ? new Error("failed") : 1);

      assert.equal(detector._listenerProcess, null);
      assert.equal(detector._sustainedTimer, null);
      assert.equal(detector._eventMicActive, null);
      cleanupDetector(detector);
    });
  }
});

test("listener stdout end invalidates state and falls back to polling", async (t) => {
  for (const [label, bufferedOutput] of [
    ["truncated output", "Event 'change' on source-out"],
    ["clean end", ""],
  ]) {
    await t.test(label, () => {
      const detector = new AudioActivityDetector();
      const child = fakeListenerProcess();
      let pollingStarts = 0;
      detector._running = true;
      detector._eventDriven = true;
      detector._startGeneration = 4;
      detector._listenerProcess = child;
      detector._startPolling = () => {
        pollingStarts += 1;
      };
      detector._onMicStateChanged(true);
      assert.ok(detector._sustainedTimer);
      detector._attachListenerStreamEndHandler(child, () => bufferedOutput, 4);

      child.stdout.emit("end");

      assert.equal(child.killed, true);
      assert.equal(detector._listenerProcess, null);
      assert.equal(detector._eventDriven, false);
      assert.equal(pollingStarts, 1);
      assert.equal(detector._sustainedTimer, null);
      assert.equal(detector._eventMicActive, null);
      cleanupDetector(detector);
    });
  }
});

test("dismissal preserves distinct Windows sessions owned by the same PID", (t) => {
  const detector = new AudioActivityDetector();
  t.after(() => cleanupDetector(detector));

  detector._parseWin32ListenerLine("MIC_START 101 1");
  detector._parseWin32ListenerLine("MIC_START 101 2");
  detector._parseWin32ListenerLine("READY");
  detector.dismiss();

  assert.equal(detector._activeMicSessions.size, 2);
  detector._parseWin32ListenerLine("MIC_STOP 101 1");
  assert.equal(detector._activeMicSessions.size, 1);
  assert.equal(detector._resetTimer, null);

  detector._parseWin32ListenerLine("MIC_STOP 101 2");
  assert.equal(detector._activeMicSessions.size, 0);
  assert.ok(detector._resetTimer);
});

test("dismissal preserves PulseAudio multi-stream activity accounting", async (t) => {
  const detector = new AudioActivityDetector();
  detector._running = true;
  t.after(() => cleanupDetector(detector));
  const snapshots = [linuxSnapshot([1, 2]), linuxSnapshot([2]), linuxSnapshot([])];
  detector._getLinuxCaptureSnapshot = async () => snapshots.shift();

  await detector._parsePactlSubscribeLine("Event 'new' on source-output #1");
  detector.dismiss();

  assert.equal(detector._activeSources, 2);
  await detector._parsePactlSubscribeLine("Event 'change' on source-output #1");
  assert.equal(detector._activeSources, 1);
  assert.equal(detector._resetTimer, null);

  await detector._parsePactlSubscribeLine("Event 'remove' on source-output #2");
  assert.equal(detector._activeSources, 0);
  assert.ok(detector._resetTimer);
});

test("Windows keeps verified inactivity timing when stop precedes dismissal", (t) => {
  const detector = new AudioActivityDetector();
  t.after(() => cleanupDetector(detector));
  detector._eventDriven = true;

  detector._parseWin32ListenerLine("MIC_START 101 1");
  detector._parseWin32ListenerLine("READY");
  detector._clearSustainedTimer();
  detector.hasPrompted = true;
  detector._parseWin32ListenerLine("MIC_STOP 101 1");
  const resetTimer = detector._resetTimer;
  assert.ok(resetTimer);

  detector.dismiss();
  assert.equal(detector._resetTimer, resetTimer);
  assert.equal(detector.hasPrompted, true);
});

test("PulseAudio keeps verified inactivity timing when stop precedes dismissal", async (t) => {
  const detector = new AudioActivityDetector();
  detector._running = true;
  t.after(() => cleanupDetector(detector));
  detector._eventDriven = true;
  const snapshots = [linuxSnapshot([1]), linuxSnapshot([])];
  detector._getLinuxCaptureSnapshot = async () => snapshots.shift();

  await detector._parsePactlSubscribeLine("Event 'new' on source-output #1");
  detector._clearSustainedTimer();
  detector.hasPrompted = true;
  await detector._parsePactlSubscribeLine("Event 'remove' on source-output #1");
  const resetTimer = detector._resetTimer;
  assert.ok(resetTimer);

  detector.dismiss();
  assert.equal(detector._resetTimer, resetTimer);
  assert.equal(detector.hasPrompted, true);
});

test("macOS keeps verified inactivity timing when stop precedes dismissal", (t) => {
  const detector = new AudioActivityDetector();
  t.after(() => cleanupDetector(detector));
  detector._eventDriven = true;

  detector._onMicStateChanged(true);
  detector._clearSustainedTimer();
  detector.hasPrompted = true;
  detector._onMicStateChanged(false);
  const resetTimer = detector._resetTimer;
  assert.ok(resetTimer);

  detector.dismiss();
  assert.equal(detector._resetTimer, resetTimer);
  assert.equal(detector.hasPrompted, true);
});

test("a new event-driven stream is reconsidered when cooldown expires", async (t) => {
  const detector = new AudioActivityDetector();
  t.after(() => cleanupDetector(detector));
  detector._running = true;
  detector._eventDriven = true;
  detector.hasPrompted = false;
  detector.lastDismissedAt = Date.now() - (5 * 60 * 1000 - 25);

  const detected = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("detection did not resume")), 2500);
    detector.once("sustained-audio-detected", (event) => {
      clearTimeout(timeout);
      resolve(event);
    });
  });

  detector._onMicStateChanged(true);
  assert.ok(detector._cooldownExpiryTimer);
  assert.equal(detector._sustainedTimer, null);

  await detected;
  assert.equal(detector.hasPrompted, true);
  assert.equal(detector._eventMicActive, true);
});
