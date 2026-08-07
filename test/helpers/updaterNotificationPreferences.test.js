const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const Module = require("node:module");

test("one pre-sync update notification is replayed after preferences synchronize", async () => {
  const autoUpdater = new EventEmitter();
  autoUpdater.setFeedURL = () => {};
  const nativeAutoUpdater = new EventEmitter();
  const originalLoad = Module._load;
  const originalNodeEnv = process.env.NODE_ENV;
  const updaterPath = require.resolve("../../src/updater");

  Module._load = function loadWithUpdaterMocks(request, parent, isMain) {
    if (request === "electron-updater") return { autoUpdater };
    if (request === "electron") return { autoUpdater: nativeAutoUpdater };
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.NODE_ENV = "production";
  delete require.cache[updaterPath];

  try {
    const UpdateManager = require("../../src/updater");
    const manager = new UpdateManager();
    let shown = 0;
    const windowManager = {
      notificationPreferencesSynchronized: false,
      notificationPrefs: {
        notificationsEnabled: true,
        notifyUpdates: true,
      },
      async showUpdateNotification() {
        shown += 1;
      },
    };
    manager.setWindowManager(windowManager);

    autoUpdater.emit("update-available", { version: "9.9.9" });
    await Promise.resolve();
    assert.equal(shown, 0);

    manager.handleNotificationPreferencesSynchronized();
    await Promise.resolve();
    assert.equal(shown, 1);

    manager.cleanup();
  } finally {
    delete require.cache[updaterPath];
    Module._load = originalLoad;
    process.env.NODE_ENV = originalNodeEnv;
  }
});
