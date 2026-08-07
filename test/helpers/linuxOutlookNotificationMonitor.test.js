const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");

const debugLogger = require("../../src/helpers/debugLogger");
const {
  CONNECTION_PHASE_TIMEOUT_MS,
  EDGE_APP_NAME,
  MATCH_AFTER_MS,
  MATCH_BEFORE_MS,
  NOTIFICATION_MATCH_RULE,
  NOTIFICATION_MATCH_RULES,
  PORTAL_NOTIFICATION_MATCH_RULE,
  LinuxOutlookNotificationMonitor,
  inspectOutlookNotificationMessage,
  isLocalSessionBusAddress,
  isPermanentConnectionError,
  parseMeetingStartTime,
  parseOutlookNotificationMessage,
  sanitizeMeetingTitle,
} = require("../../src/helpers/linuxOutlookNotificationMonitor");

function variant(type, value) {
  return [[{ type, child: [] }], [value]];
}

function notificationMessage({
  appName = EDGE_APP_NAME,
  title = "Test meeting",
  body = "16:00 ",
  origin = "outlook.office.com",
} = {}) {
  return {
    type: 1,
    destination: "org.freedesktop.Notifications",
    path: "/org/freedesktop/Notifications",
    interface: "org.freedesktop.Notifications",
    member: "Notify",
    signature: "susssasa{sv}i",
    body: [
      appName,
      0,
      "",
      title,
      body,
      [],
      [
        ["desktop-entry", variant("s", "microsoft-edge")],
        ["x-kde-origin-name", variant("s", origin)],
      ],
      -1,
    ],
  };
}

function portalNotificationMessage({
  title = "Test meeting",
  body = "16:00 ",
  includeBody = true,
  markupBody,
  desktopEntry,
  origin,
  extraEntries = [],
} = {}) {
  const notification = [["title", variant("s", title)], ...extraEntries];
  if (includeBody) {
    notification.push(["body", variant("s", body)]);
  }
  if (markupBody !== undefined) {
    notification.push(["markup-body", variant("s", markupBody)]);
  }
  if (desktopEntry !== undefined) {
    notification.push(["desktop-entry", variant("s", desktopEntry)]);
  }
  if (origin !== undefined) {
    notification.push(["x-kde-origin-name", variant("s", origin)]);
  }
  return {
    type: 1,
    destination: "org.freedesktop.portal.Desktop",
    path: "/org/freedesktop/portal/desktop",
    interface: "org.freedesktop.portal.Notification",
    member: "AddNotification",
    signature: "sa{sv}",
    body: ["notification-id", notification],
  };
}

class FakeConnection extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.ended = false;
  }

  message(message) {
    this.sent.push(message);
  }

  end() {
    this.ended = true;
  }
}

test("parses the observed KDE Outlook notification shape", () => {
  const receivedAt = new Date(2026, 6, 27, 15, 55).getTime();
  assert.deepEqual(parseOutlookNotificationMessage(notificationMessage(), receivedAt), {
    title: "Test meeting",
    scheduledAt: new Date(2026, 6, 27, 16, 0).getTime(),
    receivedAt,
    source: "outlook-notification",
    transport: "freedesktop",
  });
});

test("rejects other apps, origins, and non-calendar Outlook notifications", () => {
  const receivedAt = new Date(2026, 6, 27, 15, 55).getTime();
  assert.equal(
    parseOutlookNotificationMessage(notificationMessage({ appName: "Google Chrome" }), receivedAt),
    null
  );
  assert.equal(
    parseOutlookNotificationMessage(
      notificationMessage({ origin: "mail.example.com" }),
      receivedAt
    ),
    null
  );
  assert.equal(
    parseOutlookNotificationMessage(
      notificationMessage({ body: "A new message arrived" }),
      receivedAt
    ),
    null
  );
  assert.equal(
    parseOutlookNotificationMessage({ ...notificationMessage(), signature: "ssss" }, receivedAt),
    null
  );
  assert.equal(
    parseOutlookNotificationMessage(
      {
        ...notificationMessage(),
        destination: "org.freedesktop.portal.Desktop",
      },
      receivedAt
    ),
    null
  );
});

test("decodes portal notifications but requires positive Edge and Outlook attribution", () => {
  const receivedAt = new Date(2026, 6, 27, 15, 55).getTime();
  const unattributed = inspectOutlookNotificationMessage(
    portalNotificationMessage({
      extraEntries: [["private-field", variant("s", "Sensitive portal value")]],
    }),
    receivedAt
  );
  assert.deepEqual(unattributed, {
    status: "rejected",
    transport: "portal",
    reason: "unattributed-portal",
    diagnostics: {
      signature: "sa{sv}",
      bodyArity: 2,
      hasTitle: true,
      hasBody: true,
      hasRecognizedStartTime: true,
      hasEdgeDesktopEntry: false,
      hasOutlookOrigin: false,
      unknownFieldCount: 1,
    },
  });

  assert.deepEqual(
    parseOutlookNotificationMessage(
      portalNotificationMessage({
        desktopEntry: "microsoft-edge",
        origin: "outlook.office.com",
      }),
      receivedAt
    ),
    {
      title: "Test meeting",
      scheduledAt: new Date(2026, 6, 27, 16, 0).getTime(),
      receivedAt,
      source: "outlook-notification",
      transport: "portal",
    }
  );
});

test("extracts 24-hour and AM/PM start times from Outlook reminder bodies", () => {
  assert.equal(
    parseMeetingStartTime("Starts at 4:05 PM", new Date(2026, 6, 27, 15, 55).getTime()),
    new Date(2026, 6, 27, 16, 5).getTime()
  );
  assert.equal(
    parseMeetingStartTime("00:05 – 01:00", new Date(2026, 6, 27, 23, 58).getTime()),
    new Date(2026, 6, 28, 0, 5).getTime()
  );
  assert.equal(
    parseMeetingStartTime("Reminder: <b>23:55</b>", new Date(2026, 6, 28, 0, 3).getTime()),
    new Date(2026, 6, 27, 23, 55).getTime()
  );
  assert.equal(parseMeetingStartTime("Reference v1:23", Date.now()), null);
  assert.equal(parseMeetingStartTime("Starts at 25:00", Date.now()), null);
  assert.equal(parseMeetingStartTime("A new message arrived", Date.now()), null);
});

test("accepts strongly attributed Outlook reminders with richer body text", () => {
  const receivedAt = new Date(2026, 6, 27, 15, 45).getTime();
  assert.equal(
    parseOutlookNotificationMessage(
      notificationMessage({ body: "Starts at 16:00 · Zoom meeting" }),
      receivedAt
    )?.scheduledAt,
    new Date(2026, 6, 27, 16, 0).getTime()
  );
  assert.equal(
    parseOutlookNotificationMessage(
      portalNotificationMessage({
        body: "16:00 – 17:00 (in 15 minutes)",
        desktopEntry: "microsoft-edge",
        origin: "outlook.office.com",
      }),
      receivedAt
    )?.scheduledAt,
    new Date(2026, 6, 27, 16, 0).getTime()
  );
  assert.equal(
    parseOutlookNotificationMessage(
      portalNotificationMessage({
        includeBody: false,
        markupBody: "Starts at <b>16:00</b>",
        desktopEntry: "microsoft-edge",
        origin: "outlook.office.com",
      }),
      receivedAt
    )?.scheduledAt,
    new Date(2026, 6, 27, 16, 0).getTime()
  );
  assert.equal(
    parseOutlookNotificationMessage(
      portalNotificationMessage({
        body: "Calendar reminder",
        markupBody: "Calendar reminder: <b>16:00</b>",
        desktopEntry: "microsoft-edge",
        origin: "outlook.office.com",
      }),
      receivedAt
    )?.scheduledAt,
    new Date(2026, 6, 27, 16, 0).getTime()
  );
});

test("accepts only local Unix session-bus addresses", () => {
  const guid = "0123456789abcdef0123456789abcdef";
  assert.equal(isLocalSessionBusAddress("unix:path=/run/user/1000/bus"), true);
  assert.equal(isLocalSessionBusAddress("unix:abstract=/tmp/dbus-test"), true);
  assert.equal(isLocalSessionBusAddress(`unix:abstract=/tmp/dbus-test,guid=${guid}`), true);
  assert.equal(isLocalSessionBusAddress(`unix:guid=${guid},path=/run/user/1000/bus`), true);
  assert.equal(
    isLocalSessionBusAddress(
      `unix:path=/run/user/1000/bus,guid=${guid};unix:abstract=/tmp/dbus-fallback`
    ),
    true
  );
  assert.equal(isLocalSessionBusAddress("tcp:host=127.0.0.1,port=1234"), false);
  assert.equal(isLocalSessionBusAddress("unixexec:path=/usr/bin/dbus-launch"), false);
  assert.equal(isLocalSessionBusAddress("launchd:env=DBUS_LAUNCHD_SESSION_BUS_SOCKET"), false);
  assert.equal(isLocalSessionBusAddress("unix:path="), false);
  assert.equal(isLocalSessionBusAddress("unix:PATH=/run/user/1000/bus"), false);
  assert.equal(isLocalSessionBusAddress("unix:path=/run/user/1000/bus,foo=bar"), false);
  assert.equal(isLocalSessionBusAddress("unix:path=/run/user/1000/bus,guid=not-a-guid"), false);
  assert.equal(
    isLocalSessionBusAddress(`unix:path=/run/user/1000/bus,guid=${guid},guid=${guid}`),
    false
  );
  assert.equal(
    isLocalSessionBusAddress(`unix:path=/run/user/1000/bus,abstract=/tmp/dbus,guid=${guid}`),
    false
  );
  assert.equal(isLocalSessionBusAddress("unix:foo=/run/user/1000/bus"), false);
  assert.equal(isLocalSessionBusAddress(" unix:path=/run/user/1000/bus"), false);
  assert.equal(isLocalSessionBusAddress("unix:path=/run/user/1000/bus "), false);
  assert.equal(isLocalSessionBusAddress("unix:path= /run/user/1000/bus"), false);
  assert.equal(isLocalSessionBusAddress("unix:path=\t/run/user/1000/bus"), false);
  assert.equal(
    isLocalSessionBusAddress("unix:path=/run/user/1000/bus; unix:path=/tmp/fallback"),
    false
  );
  assert.equal(isLocalSessionBusAddress(";unix:path=/run/user/1000/bus"), false);
  assert.equal(isLocalSessionBusAddress("unix:path=/run/user/1000/bus;"), false);
  assert.equal(
    isLocalSessionBusAddress("unix:path=/run/user/1000/bus;;unix:path=/tmp/fallback"),
    false
  );
  assert.equal(
    isLocalSessionBusAddress("unix:path=/run/user/1000/bus;tcp:host=127.0.0.1,port=1234"),
    false
  );
});

test("sanitizes and bounds notification titles", () => {
  assert.equal(sanitizeMeetingTitle("  Test\u001b[2J\nmeeting\u202e  "), "Test [2J meeting");
  assert.equal(sanitizeMeetingTitle("\u001b\u202e"), null);
  assert.equal(Array.from(sanitizeMeetingTitle("x".repeat(250))).length, 200);
});

test("performs the raw D-Bus monitor handshake and caches matching reminders", () => {
  const connection = new FakeConnection();
  const now = new Date(2026, 6, 27, 15, 55).getTime();
  const monitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "KDE",
    now: () => now,
    createConnection: () => connection,
  });

  monitor.start();
  connection.emit("connect");
  assert.equal(connection.sent[0].member, "Hello");

  connection.emit("message", { type: 2, replySerial: 1 });
  assert.deepEqual(connection.sent[1], {
    type: 1,
    serial: 2,
    path: "/org/freedesktop/DBus",
    destination: "org.freedesktop.DBus",
    interface: "org.freedesktop.DBus.Monitoring",
    member: "BecomeMonitor",
    signature: "asu",
    body: [NOTIFICATION_MATCH_RULES, 0],
  });
  assert.equal(NOTIFICATION_MATCH_RULE.includes(`arg0='${EDGE_APP_NAME}'`), true);
  assert.equal(NOTIFICATION_MATCH_RULES.includes(PORTAL_NOTIFICATION_MATCH_RULE), true);

  connection.emit("message", { type: 2, replySerial: 2 });
  connection.emit("message", notificationMessage());

  assert.equal(monitor.getBestCandidate(now + 10 * 60 * 1000)?.title, "Test meeting");
});

test("logs rate-limited portal rejection metadata without notification content", () => {
  const connection = new FakeConnection();
  const now = new Date(2026, 6, 27, 15, 55).getTime();
  const monitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "KDE",
    now: () => now,
    createConnection: () => connection,
  });
  const rawTitle = "Sensitive meeting title";
  const rawBody = "16:00";
  const rawPrivateValue = "Sensitive private portal value";
  const logs = [];
  const originalDebug = debugLogger.debug;
  debugLogger.debug = (...args) => {
    if (args[0] === "Outlook notification message rejected") logs.push(args);
  };

  try {
    monitor.start();
    connection.emit("connect");
    connection.emit("message", { type: 2, replySerial: 1 });
    connection.emit("message", { type: 2, replySerial: 2 });
    const message = portalNotificationMessage({
      title: rawTitle,
      body: rawBody,
      extraEntries: [["private-field", variant("s", rawPrivateValue)]],
    });
    connection.emit("message", message);
    connection.emit("message", message);
  } finally {
    debugLogger.debug = originalDebug;
    monitor.stop();
  }

  assert.equal(logs.length, 1);
  assert.equal(logs[0][1].transport, "portal");
  assert.equal(logs[0][1].reason, "unattributed-portal");
  assert.equal(logs[0][1].hasTitle, true);
  assert.equal(logs[0][1].hasRecognizedStartTime, true);
  assert.equal(logs[0][1].unknownFieldCount, 1);
  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes(rawTitle), false);
  assert.equal(serializedLogs.includes(rawBody), false);
  assert.equal(serializedLogs.includes(rawPrivateValue), false);
  assert.equal(serializedLogs.includes("notification-id"), false);
});

test("rate-limits accepted-cache and candidate-selection diagnostics", () => {
  const startAt = new Date(2026, 6, 27, 15, 55).getTime();
  const monitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "KDE",
  });
  const cacheLogs = [];
  const selectionLogs = [];
  const originalDebug = debugLogger.debug;
  const originalInfo = debugLogger.info;
  debugLogger.debug = (...args) => {
    if (args[0] === "Outlook meeting notification candidate selection") {
      selectionLogs.push(args);
    }
  };
  debugLogger.info = (...args) => {
    if (args[0] === "Outlook meeting notification context cached") cacheLogs.push(args);
  };

  const cacheAt = (receivedAt) => {
    monitor._cacheCandidate({
      title: "Sensitive meeting title",
      scheduledAt: startAt + 5 * 60 * 1000,
      receivedAt,
      source: "outlook-notification",
      transport: "freedesktop",
    });
  };

  try {
    cacheAt(startAt);
    cacheAt(startAt + 1000);
    monitor.getBestCandidate(startAt);
    monitor.getBestCandidate(startAt + 1000);

    cacheAt(startAt + 61 * 1000);
    monitor.getBestCandidate(startAt + 61 * 1000);
  } finally {
    debugLogger.debug = originalDebug;
    debugLogger.info = originalInfo;
    monitor.stop();
  }

  assert.equal(cacheLogs.length, 2);
  assert.equal(cacheLogs[1][1].suppressedSinceLastLog, 1);
  assert.equal(selectionLogs.length, 2);
  assert.equal(selectionLogs[1][1].suppressedSinceLastLog, 1);
  assert.equal(
    JSON.stringify([...cacheLogs, ...selectionLogs]).includes("Sensitive meeting"),
    false
  );
});

test("prefers the newest displayed reminder among meetings that have started", () => {
  const now = new Date(2026, 6, 27, 16, 0).getTime();
  const monitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "KDE",
  });
  monitor.candidates = [
    {
      title: "Do not schedule",
      scheduledAt: now - 2 * 60 * 1000,
      receivedAt: now - 60 * 60 * 1000,
      source: "outlook-notification",
    },
    {
      title: "My meeting",
      scheduledAt: now - 30 * 60 * 1000,
      receivedAt: now - 5 * 60 * 1000,
      source: "outlook-notification",
    },
  ];

  assert.equal(monitor.getBestCandidate(now)?.title, "My meeting");
});

test("does not let a newer upcoming reminder displace a meeting that has started", () => {
  const now = new Date(2026, 6, 27, 16, 0).getTime();
  const monitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "KDE",
  });
  monitor.candidates = [
    {
      title: "Current meeting",
      scheduledAt: now - 20 * 60 * 1000,
      receivedAt: now - 5000,
      source: "outlook-notification",
    },
    {
      title: "Upcoming meeting",
      scheduledAt: now + 10 * 60 * 1000,
      receivedAt: now - 1000,
      source: "outlook-notification",
    },
  ];

  assert.equal(monitor.getBestCandidate(now)?.title, "Current meeting");
});

test("uses the nearest scheduled event when every eligible reminder is upcoming", () => {
  const now = new Date(2026, 6, 27, 16, 0).getTime();
  const monitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "KDE",
  });
  monitor.candidates = [
    {
      title: "Later upcoming meeting",
      scheduledAt: now + 20 * 60 * 1000,
      receivedAt: now - 1000,
      source: "outlook-notification",
    },
    {
      title: "Next meeting",
      scheduledAt: now + 5 * 60 * 1000,
      receivedAt: now - 5000,
      source: "outlook-notification",
    },
  ];

  assert.equal(monitor.getBestCandidate(now)?.title, "Next meeting");
});

test("enforces the notification matching window", () => {
  const scheduledAt = new Date(2026, 6, 27, 16, 0).getTime();
  const candidate = {
    title: "Test meeting",
    scheduledAt,
    receivedAt: scheduledAt - 15 * 60 * 1000,
    source: "outlook-notification",
  };
  const resolveAt = (at) => {
    const monitor = new LinuxOutlookNotificationMonitor({
      platform: "linux",
      desktop: "KDE",
    });
    monitor.candidates = [candidate];
    return monitor.getBestCandidate(at);
  };

  assert.equal(resolveAt(scheduledAt - MATCH_BEFORE_MS)?.title, "Test meeting");
  assert.equal(resolveAt(scheduledAt + MATCH_AFTER_MS)?.title, "Test meeting");
  assert.equal(resolveAt(scheduledAt - MATCH_BEFORE_MS - 1), null);
  assert.equal(resolveAt(scheduledAt + MATCH_AFTER_MS + 1), null);
});

test("deduplicates reminders, bounds the cache, and clears it on stop", () => {
  const now = new Date(2026, 6, 27, 16, 0).getTime();
  const monitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "KDE",
  });
  for (let index = 0; index < 12; index += 1) {
    monitor._cacheCandidate({
      title: `Meeting ${index}`,
      scheduledAt: now + index * 60 * 1000,
      receivedAt: now + index,
      source: "outlook-notification",
    });
  }
  monitor._cacheCandidate({
    title: "Meeting 11",
    scheduledAt: now + 11 * 60 * 1000,
    receivedAt: now + 100,
    source: "outlook-notification",
  });

  assert.equal(monitor.candidates.length, 10);
  assert.equal(
    monitor.candidates.filter((candidate) => candidate.title === "Meeting 11").length,
    1
  );
  monitor.stop();
  assert.deepEqual(monitor.candidates, []);
});

test("retains candidate identity across duplicate reminders and consumes it once", () => {
  const now = new Date(2026, 6, 27, 16, 0).getTime();
  const monitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "KDE",
  });
  const candidate = {
    title: "Test meeting",
    scheduledAt: now,
    receivedAt: now - 1000,
    source: "outlook-notification",
    transport: "freedesktop",
  };

  monitor._cacheCandidate(candidate);
  const id = monitor.candidates[0].id;
  monitor._cacheCandidate({ ...candidate, receivedAt: now });

  assert.equal(monitor.candidates[0].id, id);
  assert.equal(monitor.consumeCandidate(id), true);
  assert.equal(monitor.consumeCandidate(id), false);
  assert.equal(monitor.getBestCandidate(now), null);
});

test("does not retry a permanently denied monitor connection", () => {
  const connections = [];
  const timers = [];
  const monitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "KDE",
    createConnection: () => {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timer.cleared = true;
    },
  });

  monitor.start();
  connections[0].emit("connect");
  connections[0].emit("message", { type: 2, replySerial: 1 });
  connections[0].emit("message", {
    type: 3,
    replySerial: 2,
    errorName: "org.freedesktop.DBus.Error.AccessDenied",
  });

  assert.equal(connections[0].ended, true);
  assert.equal(timers.length, 0);

  monitor.stop();
  monitor.start();
  assert.equal(connections.length, 2);
});

test("does not retry permission failures from connection or Hello phases", () => {
  const emittedConnection = new FakeConnection();
  const emittedTimers = [];
  const emittedMonitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "KDE",
    createConnection: () => emittedConnection,
    setTimeout: (callback, delay) => {
      emittedTimers.push({ callback, delay });
    },
  });

  emittedMonitor.start();
  const permissionError = new Error("Session bus permission denied");
  permissionError.code = "EACCES";
  emittedConnection.emit("error", permissionError);
  assert.equal(emittedConnection.ended, true);
  assert.equal(emittedTimers.length, 0);

  const helloConnection = new FakeConnection();
  const helloTimers = [];
  const helloMonitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "KDE",
    createConnection: () => helloConnection,
    setTimeout: (callback, delay) => {
      helloTimers.push({ callback, delay });
    },
  });

  helloMonitor.start();
  helloConnection.emit("connect");
  helloConnection.emit("message", {
    type: 3,
    replySerial: 1,
    errorName: "org.freedesktop.DBus.Error.AccessDenied",
  });
  assert.equal(helloConnection.ended, true);
  assert.equal(helloTimers.length, 0);
});

test("does not retry structured and semantic access failures", () => {
  const connectionErrors = [
    Object.assign(new Error("Connection rejected"), {
      code: "ERR_ACCESS_REQUIRED",
    }),
    new Error("Operation not permitted"),
  ];

  for (const error of connectionErrors) {
    const connection = new FakeConnection();
    const timers = [];
    const monitor = new LinuxOutlookNotificationMonitor({
      platform: "linux",
      desktop: "KDE",
      createConnection: () => connection,
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
      },
    });

    monitor.start();
    connection.emit("error", error);
    assert.equal(connection.ended, true);
    assert.equal(timers.length, 0);
  }

  const creationTimers = [];
  const creationMonitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "KDE",
    createConnection: () => {
      const error = new Error("Connection rejected");
      error.code = "ERR_POLICY_DENIAL";
      throw error;
    },
    setTimeout: (callback, delay) => {
      creationTimers.push({ callback, delay });
    },
  });
  creationMonitor.start();
  assert.equal(creationTimers.length, 0);
});

test("normalizes structured permanent security failure families", () => {
  const permanentErrors = [
    { code: "ERR_AUTH_REQUIRED" },
    { errorName: "org.example.AccessDenial" },
    { name: "AuthorizationRequirement" },
    { message: "PermissionFailure" },
    { code: "ERR-PERMISSION-DENIED" },
    { errorName: "org.example.AuthFailed" },
    { code: "ACCESSDENIAL" },
    { errorName: "accessdenial" },
    { name: "AUTHORIZATIONREQUIREMENT" },
    { message: "permissionfailure" },
    { name: "AuthenticationError" },
    { code: "AUTHENTICATION_ERROR" },
    { message: "authenticationerror" },
    { errorName: "org.example.AuthorizationError" },
    { code: "PERMISSION_ERROR" },
  ];

  for (const error of permanentErrors) {
    assert.equal(isPermanentConnectionError(error), true);
  }
});

test("does not retry terminal D-Bus authentication and policy failures", () => {
  const authenticationErrors = [
    "No authentication methods left to try",
    "REJECTED EXTERNAL DBUS_COOKIE_SHA1",
    "Keyrings directory is not owned by the current user. Aborting authentication",
  ];

  for (const message of authenticationErrors) {
    const connection = new FakeConnection();
    const timers = [];
    const monitor = new LinuxOutlookNotificationMonitor({
      platform: "linux",
      desktop: "KDE",
      createConnection: () => connection,
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
      },
    });

    monitor.start();
    connection.emit("error", new Error(message));
    assert.equal(connection.ended, true);
    assert.equal(timers.length, 0);
  }

  const policyConnection = new FakeConnection();
  const policyTimers = [];
  const policyMonitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "KDE",
    createConnection: () => policyConnection,
    setTimeout: (callback, delay) => {
      policyTimers.push({ callback, delay });
    },
  });

  policyMonitor.start();
  policyConnection.emit("connect");
  policyConnection.emit("message", { type: 2, replySerial: 1 });
  policyConnection.emit("message", {
    type: 3,
    replySerial: 2,
    errorName: "org.freedesktop.DBus.Error.InteractiveAuthorizationRequired",
  });
  assert.equal(policyConnection.ended, true);
  assert.equal(policyTimers.length, 0);
});

test("does not retry missing D-Bus authentication cookie files", () => {
  const connection = new FakeConnection();
  const timers = [];
  const monitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "KDE",
    createConnection: () => connection,
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay });
    },
  });
  const error = new Error("ENOENT: no such file or directory, stat '/home/test/.dbus-keyrings'");
  error.code = "ENOENT";
  error.path = "/home/test/.dbus-keyrings";
  error.syscall = "stat";

  monitor.start();
  connection.emit("error", error);

  assert.equal(connection.ended, true);
  assert.equal(timers.length, 0);
});

test("classifies permanent policy text in generic D-Bus error replies", () => {
  const cases = [
    { replySerial: 1, body: "Access denied by policy" },
    {
      replySerial: 1,
      errorName: "org.freedesktop.PolicyKit1.Error.NotAuthorized",
    },
    { replySerial: 1, body: "Access is denied" },
    { replySerial: 2, body: "Interactive authorization required" },
    {
      replySerial: 2,
      errorName: "org.freedesktop.DBus.Error.PermissionDenied",
    },
    { replySerial: 2, body: "Authorization is required" },
    { replySerial: 2, body: "Authorization denied" },
    { replySerial: 2, body: "Operation prohibited by system policy" },
    { replySerial: 2, body: "Denial by policy" },
    { replySerial: 2, body: "System policy denial" },
    { replySerial: 2, body: "Prohibition by system policy" },
    { replySerial: 2, body: "Policy prohibition prevents monitoring" },
    { replySerial: 2, body: "System policy prohibits monitoring" },
  ];
  for (const { replySerial, body, errorName } of cases) {
    const connection = new FakeConnection();
    const timers = [];
    const monitor = new LinuxOutlookNotificationMonitor({
      platform: "linux",
      desktop: "KDE",
      createConnection: () => connection,
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
      },
    });

    monitor.start();
    connection.emit("connect");
    if (replySerial === 2) {
      connection.emit("message", { type: 2, replySerial: 1 });
    }
    connection.emit("message", {
      type: 3,
      replySerial,
      errorName: errorName ?? "org.freedesktop.DBus.Error.Failed",
      body: body ? [body] : [],
    });

    assert.equal(connection.ended, true);
    assert.equal(timers.length, 0);
  }
});

test("retries transient connection failures with backoff", () => {
  const connections = [];
  const timers = [];
  const monitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "KDE",
    createConnection: () => {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
    setTimeout: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
  });

  monitor.start();
  const error = new Error("ENOENT: no such file or directory, connect '/run/user/1000/bus'");
  error.code = "ENOENT";
  error.path = "/run/user/1000/bus";
  connections[0].emit("error", error);

  assert.equal(connections[0].ended, true);
  assert.equal(timers[0].delay, 1000);
  timers[0].callback();
  assert.equal(connections.length, 2);
  monitor.stop();
});

test("reconnects after resume while preserving eligible candidate context", () => {
  const connections = [];
  const now = new Date(2026, 6, 27, 16, 0).getTime();
  const monitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "KDE",
    now: () => now,
    createConnection: () => {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
  });
  monitor.start();
  monitor._cacheCandidate({
    title: "Test meeting",
    scheduledAt: now,
    receivedAt: now - 5 * 60 * 1000,
    source: "outlook-notification",
    transport: "freedesktop",
  });
  const candidateId = monitor.candidates[0].id;

  assert.equal(monitor.reconnect(), true);
  assert.equal(connections[0].ended, true);
  assert.equal(connections.length, 2);
  assert.equal(monitor.candidates[0].id, candidateId);
  assert.equal(monitor.getBestCandidate(now)?.title, "Test meeting");

  connections[1].emit("connect");
  connections[1].emit("message", { type: 2, replySerial: 1 });
  connections[1].emit("message", { type: 2, replySerial: 2 });
  assert.equal(monitor.monitoring, true);
  monitor.stop();
});

test("keeps missing sockets transient even when their paths resemble security errors", () => {
  for (const path of [
    "/tmp/permissionfailure",
    "/tmp/accessdenial",
    "/tmp/.dbus-keyrings/bus",
    "/tmp/stat/.dbus-keyrings/bus",
  ]) {
    const error = new Error(`ENOENT: no such file or directory, connect '${path}'`);
    error.code = "ENOENT";
    error.path = path;
    error.syscall = "connect";
    assert.equal(isPermanentConnectionError(error), false);
  }
});

test("tries the next local Unix address before backing off", () => {
  const connections = [new FakeConnection(), new FakeConnection()];
  const attemptedAddresses = [];
  const retryTimers = [];
  const monitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "KDE",
    busAddress: "unix:path=/tmp/missing-bus;unix:path=/run/user/1000/bus",
    createConnection: ({ busAddress }) => {
      attemptedAddresses.push(busAddress);
      return connections[attemptedAddresses.length - 1];
    },
    setTimeout: (callback, delay) => {
      retryTimers.push({ callback, delay });
    },
  });

  monitor.start();
  const error = new Error("ENOENT: no such file or directory");
  error.code = "ENOENT";
  error.path = "/tmp/missing-bus";
  connections[0].emit("error", error);

  assert.equal(connections[0].ended, true);
  assert.deepEqual(attemptedAddresses, [
    "unix:path=/tmp/missing-bus",
    "unix:path=/run/user/1000/bus",
  ]);
  assert.equal(retryTimers.length, 0);

  connections[1].emit("connect");
  connections[1].emit("message", { type: 2, replySerial: 1 });
  connections[1].emit("message", { type: 2, replySerial: 2 });
  assert.equal(monitor.monitoring, true);
  monitor.stop();
});

test("times out stalled D-Bus connection phases and retries transiently", () => {
  for (const phase of ["connect", "hello", "monitor"]) {
    const connection = new FakeConnection();
    const retryTimers = [];
    const phaseTimers = [];
    const monitor = new LinuxOutlookNotificationMonitor({
      platform: "linux",
      desktop: "KDE",
      createConnection: () => connection,
      setTimeout: (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        retryTimers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        timer.cleared = true;
      },
      phaseSetTimeout: (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        phaseTimers.push(timer);
        return timer;
      },
      phaseClearTimeout: (timer) => {
        timer.cleared = true;
      },
    });

    monitor.start();
    if (phase === "hello" || phase === "monitor") {
      connection.emit("connect");
    }
    if (phase === "monitor") {
      connection.emit("message", { type: 2, replySerial: 1 });
    }

    const activeDeadline = phaseTimers.find((timer) => !timer.cleared);
    assert.equal(activeDeadline.delay, CONNECTION_PHASE_TIMEOUT_MS);
    activeDeadline.callback();

    assert.equal(connection.ended, true);
    assert.equal(
      retryTimers.some((timer) => timer.delay === 1000),
      true
    );
    monitor.stop();
  }
});

test("keeps an error sink for late connection errors after disposal", () => {
  const connection = new FakeConnection();
  const monitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "KDE",
    createConnection: () => connection,
  });

  monitor.start();
  monitor.stop();

  assert.equal(connection.ended, true);
  assert.doesNotThrow(() => {
    connection.emit("error", new Error("Late socket error"));
  });
});

test("does not connect outside KDE on Linux", () => {
  let connectionCount = 0;
  const monitor = new LinuxOutlookNotificationMonitor({
    platform: "linux",
    desktop: "GNOME",
    createConnection: () => {
      connectionCount += 1;
      return new FakeConnection();
    },
  });
  monitor.start();
  assert.equal(connectionCount, 0);
});

test("matches KDE as an exact desktop token", () => {
  const createConnection = () => new FakeConnection();
  assert.equal(
    new LinuxOutlookNotificationMonitor({
      platform: "linux",
      desktop: "KDE:Plasma",
      createConnection,
    }).isSupported(),
    true
  );
  assert.equal(
    new LinuxOutlookNotificationMonitor({
      platform: "linux",
      desktop: "NotKDE",
      createConnection,
    }).isSupported(),
    false
  );
});
