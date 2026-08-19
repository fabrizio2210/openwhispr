const debugLogger = require("./debugLogger");

const DBUS_PATH = "/org/freedesktop/DBus";
const DBUS_DESTINATION = "org.freedesktop.DBus";
const DBUS_INTERFACE = "org.freedesktop.DBus";
const DBUS_MONITORING_INTERFACE = "org.freedesktop.DBus.Monitoring";
const NOTIFICATIONS_PATH = "/org/freedesktop/Notifications";
const NOTIFICATIONS_INTERFACE = "org.freedesktop.Notifications";
const PORTAL_DESTINATION = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const PORTAL_INTERFACE = "org.freedesktop.portal.Notification";
const EDGE_APP_NAME = "Microsoft Edge";
const EDGE_DESKTOP_ENTRY = "microsoft-edge";
const OUTLOOK_ORIGIN = "outlook.office.com";
const OUTLOOK_CLOUD_ORIGIN = "outlook.cloud.microsoft";
const OUTLOOK_ORIGINS = new Set([OUTLOOK_ORIGIN, OUTLOOK_CLOUD_ORIGIN]);
const NOTIFY_SIGNATURE = "susssasa{sv}i";
const PORTAL_ADD_SIGNATURE = "sa{sv}";
const METHOD_CALL = 1;
const METHOD_RETURN = 2;
const ERROR = 3;
const HELLO_SERIAL = 1;
const MONITOR_SERIAL = 2;
const MAX_CANDIDATES = 10;
const TITLE_MAX_LENGTH = 200;
const BODY_SCAN_MAX_LENGTH = 1000;
const MATCH_BEFORE_MS = 30 * 60 * 1000;
const MATCH_AFTER_MS = 60 * 60 * 1000;
const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 30 * 1000;
const CONNECTION_PHASE_TIMEOUT_MS = 10 * 1000;
const DIAGNOSTIC_INTERVAL_MS = 60 * 1000;
const PERMANENT_MONITOR_ERRORS = new Set([
  "org.freedesktop.DBus.Error.AccessDenied",
  "org.freedesktop.DBus.Error.AuthFailed",
  "org.freedesktop.DBus.Error.InteractiveAuthorizationRequired",
  "org.freedesktop.DBus.Error.MatchRuleInvalid",
  "org.freedesktop.DBus.Error.NotSupported",
  "org.freedesktop.DBus.Error.UnknownMethod",
]);
const PERMANENT_CONNECTION_CODES = new Set(["EACCES", "EPERM", "UNSUPPORTED_DBUS_TRANSPORT"]);

function quoteDbusMatchValue(value) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function isPermanentConnectionError(error) {
  const normalizedCode = typeof error?.code === "string" ? error.code.toUpperCase() : null;
  if (PERMANENT_CONNECTION_CODES.has(normalizedCode)) {
    return true;
  }
  const identifiers = [
    error?.code,
    error?.errorName,
    error?.name,
    error?.message,
    error?.dbusErrorText,
    error?.path,
  ].filter((value) => typeof value === "string");
  if (normalizedCode === "ENOENT") {
    const syscall = String(error?.syscall || "").toLowerCase();
    if (syscall === "connect") return false;
    const authenticationStateOperation =
      ["stat", "lstat", "open", "read", "access"].includes(syscall) ||
      (!syscall &&
        typeof error?.message === "string" &&
        /\b(?:stat|lstat|open|read|access)\s+['"]?[^'"\r\n]*(?:^|[/\\])\.dbus-keyrings(?:[/\\]|$)/i.test(
          error.message
        ));
    const missingAuthenticationState =
      identifiers.some((value) => /(?:^|[/\\])\.dbus-keyrings(?:[/\\]|$)/i.test(value)) &&
      authenticationStateOperation;
    return missingAuthenticationState;
  }
  return identifiers.some((value) => {
    if (PERMANENT_MONITOR_ERRORS.has(value)) return true;
    const normalized = value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[^a-z0-9]+/gi, " ")
      .trim();
    const compact = normalized.toLowerCase().replace(/\s+/g, "");
    const securitySubject = /\b(?:auth|authentication|authorization|access|permission)\b/i.test(
      normalized
    );
    const terminalOutcome =
      /\b(?:denied|denial|required|requirement|failed|failure|forbidden|prohibited|error)\b/i.test(
        normalized
      );
    const compactSecurityFailure = [
      "auth",
      "authentication",
      "authorization",
      "access",
      "permission",
    ].some((subject) =>
      [
        "denied",
        "denial",
        "required",
        "requirement",
        "failed",
        "failure",
        "forbidden",
        "prohibited",
        "error",
      ].some((outcome) => compact.includes(`${subject}${outcome}`))
    );
    return (
      (securitySubject && terminalOutcome) ||
      compactSecurityFailure ||
      compact.includes("notauthorized") ||
      compact.includes("notpermitted") ||
      /(?:denied|prohibited|denial|prohibition)(?:system)?policy|(?:system)?policy(?:denies|denied|denial|prohibits|prohibited|prohibition|forbids|forbidden|disallows|blocked)/.test(
        compact
      ) ||
      /\bnot (?:authorized|permitted)\b|(?:denied|prohibited|denial|prohibition).{0,20}(?:system )?policy|(?:system )?policy.{0,40}(?:denies|denied|denial|prohibits|prohibited|prohibition|forbids|forbidden|disallows|blocked)|^rejected(?:\s|$)|cookie not found|no authentication methods|aborting authentication/i.test(
        normalized
      )
    );
  });
}

function createDbusReplyError(message, fallbackMessage) {
  const error = new Error(message?.errorName || fallbackMessage);
  error.errorName = message?.errorName;
  error.dbusErrorText = Array.isArray(message?.body)
    ? message.body.filter((value) => typeof value === "string").join(" ")
    : "";
  return error;
}

function isLocalSessionBusAddress(value) {
  if (typeof value !== "string" || !value) return false;
  const addresses = value.split(";");
  if (
    addresses.length === 0 ||
    addresses.some((address) => !address || address !== address.trim())
  ) {
    return false;
  }

  return addresses.every((address) => {
    if (!address.startsWith("unix:")) return false;
    const parameters = address.slice(address.indexOf(":") + 1).split(",");
    const parsedParameters = new Map();

    for (const parameter of parameters) {
      const separatorIndex = parameter.indexOf("=");
      if (separatorIndex <= 0) return false;
      const key = parameter.slice(0, separatorIndex);
      const parameterValue = parameter.slice(separatorIndex + 1);
      if (
        parsedParameters.has(key) ||
        parameterValue.length === 0 ||
        parameterValue !== parameterValue.trim()
      ) {
        return false;
      }
      parsedParameters.set(key, parameterValue);
    }

    const routingKeys = ["path", "abstract", "socket"].filter((key) => parsedParameters.has(key));
    if (routingKeys.length !== 1) return false;
    if ([...parsedParameters.keys()].some((key) => !routingKeys.includes(key) && key !== "guid")) {
      return false;
    }
    return !parsedParameters.has("guid") || /^[0-9a-f]{32}$/i.test(parsedParameters.get("guid"));
  });
}

const NOTIFICATION_MATCH_RULE = [
  "type='method_call'",
  "destination='org.freedesktop.Notifications'",
  "path='/org/freedesktop/Notifications'",
  "interface='org.freedesktop.Notifications'",
  "member='Notify'",
  `arg0=${quoteDbusMatchValue(EDGE_APP_NAME)}`,
].join(",");
const PORTAL_NOTIFICATION_MATCH_RULE = [
  "type='method_call'",
  `destination='${PORTAL_DESTINATION}'`,
  `path='${PORTAL_PATH}'`,
  `interface='${PORTAL_INTERFACE}'`,
  "member='AddNotification'",
].join(",");
const NOTIFICATION_MATCH_RULES = [NOTIFICATION_MATCH_RULE, PORTAL_NOTIFICATION_MATCH_RULE];

function sanitizeMeetingTitle(value) {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, TITLE_MAX_LENGTH).join("");
}

function unwrapDbusVariant(value) {
  const signatureTree = value?.[0];
  const hasSignatureTree =
    (Array.isArray(signatureTree) &&
      signatureTree.length > 0 &&
      signatureTree.every(
        (node) => node && typeof node === "object" && typeof node.type === "string"
      )) ||
    (signatureTree && typeof signatureTree === "object" && typeof signatureTree.type === "string");

  if (Array.isArray(value) && value.length === 2 && hasSignatureTree && Array.isArray(value[1])) {
    const payload = value[1];
    if (Array.isArray(payload) && payload.length === 1) {
      return unwrapDbusVariant(payload[0]);
    }
    return unwrapDbusVariant(payload);
  }
  return value;
}

function getDictValue(entries, key) {
  if (!Array.isArray(entries)) return undefined;
  const entry = entries.find(
    (candidate) => Array.isArray(candidate) && candidate.length === 2 && candidate[0] === key
  );
  return entry ? unwrapDbusVariant(entry[1]) : undefined;
}

function parseMeetingStartTime(value, referenceMs) {
  if (typeof value !== "string" || !Number.isFinite(referenceMs)) return null;
  const normalized = value
    .slice(0, BODY_SCAN_MAX_LENGTH)
    .replace(/[\u00a0\u202f]/g, " ")
    .trim();
  const timeToken =
    /(?:^|[^\p{L}\p{N}])(\d{1,2}):(\d{2})(?:\s*([ap])\.?\s*m\.?)?(?=$|[^\p{L}\p{N}])/giu;

  let hour;
  let minute;
  let meridiem;
  for (const match of normalized.matchAll(timeToken)) {
    const candidateHour = Number(match[1]);
    const candidateMinute = Number(match[2]);
    const candidateMeridiem = match[3]?.toLowerCase() || null;
    const validHour = candidateMeridiem
      ? candidateHour >= 1 && candidateHour <= 12
      : candidateHour <= 23;
    if (validHour && candidateMinute <= 59) {
      hour = candidateHour;
      minute = candidateMinute;
      meridiem = candidateMeridiem;
      break;
    }
  }
  if (hour === undefined) return null;

  if (meridiem) {
    if (hour === 12) hour = 0;
    if (meridiem === "p") hour += 12;
  }

  const reference = new Date(referenceMs);
  const candidates = [-1, 0, 1].map((dayOffset) => {
    const candidate = new Date(
      reference.getFullYear(),
      reference.getMonth(),
      reference.getDate(),
      hour,
      minute,
      0,
      0
    );
    candidate.setDate(candidate.getDate() + dayOffset);
    return candidate.getTime();
  });

  return candidates.reduce((best, candidate) =>
    Math.abs(candidate - referenceMs) < Math.abs(best - referenceMs) ? candidate : best
  );
}

function getNotificationTransport(message) {
  if (message?.type !== METHOD_CALL) return null;
  if (
    message.destination === "org.freedesktop.Notifications" &&
    message.path === NOTIFICATIONS_PATH &&
    message.interface === NOTIFICATIONS_INTERFACE &&
    message.member === "Notify"
  ) {
    return "freedesktop";
  }
  if (
    message.destination === PORTAL_DESTINATION &&
    message.path === PORTAL_PATH &&
    message.interface === PORTAL_INTERFACE &&
    message.member === "AddNotification"
  ) {
    return "portal";
  }
  return null;
}

function safeSignature(value) {
  return typeof value === "string" && value.length <= 64 ? value : null;
}

function diagnosticShape(message, fields = {}) {
  return {
    signature: safeSignature(message?.signature),
    bodyArity: Array.isArray(message?.body) ? message.body.length : null,
    hasTitle: fields.hasTitle === true,
    hasBody: fields.hasBody === true,
    hasRecognizedStartTime: fields.hasRecognizedStartTime === true,
    hasEdgeDesktopEntry: fields.hasEdgeDesktopEntry === true,
    hasOutlookOrigin: fields.hasOutlookOrigin === true,
    unknownFieldCount: Number.isInteger(fields.unknownFieldCount) ? fields.unknownFieldCount : null,
  };
}

function rejectedNotification(transport, reason, message, fields) {
  return {
    status: "rejected",
    transport,
    reason,
    diagnostics: diagnosticShape(message, fields),
  };
}

const PORTAL_KNOWN_FIELDS = new Set([
  "title",
  "body",
  "markup-body",
  "icon",
  "sound",
  "priority",
  "default-action",
  "default-action-target",
  "buttons",
  "display-hint",
  "category",
  "desktop-entry",
  "x-kde-origin-name",
]);

function inspectOutlookNotificationMessage(message, receivedAt) {
  const transport = getNotificationTransport(message);
  if (!transport) return { status: "unrelated" };

  if (transport === "freedesktop") {
    if (message.signature !== NOTIFY_SIGNATURE) {
      return rejectedNotification(transport, "invalid-signature", message);
    }
    if (!Array.isArray(message.body) || message.body.length < 7) {
      return rejectedNotification(transport, "invalid-body", message);
    }

    const [appName, , , rawTitle, rawTime, , hints] = message.body;
    const title = sanitizeMeetingTitle(rawTitle);
    const scheduledAt = parseMeetingStartTime(rawTime, receivedAt);
    const fields = {
      hasTitle: title !== null,
      hasBody: typeof rawTime === "string",
      hasRecognizedStartTime: scheduledAt !== null,
      hasEdgeDesktopEntry: getDictValue(hints, "desktop-entry") === EDGE_DESKTOP_ENTRY,
      hasOutlookOrigin: OUTLOOK_ORIGINS.has(getDictValue(hints, "x-kde-origin-name")),
    };

    if (appName !== EDGE_APP_NAME) {
      return rejectedNotification(transport, "wrong-app", message, fields);
    }
    if (!fields.hasOutlookOrigin) {
      return rejectedNotification(transport, "wrong-origin", message, fields);
    }
    if (!title) {
      return rejectedNotification(transport, "missing-title", message, fields);
    }
    if (scheduledAt === null) {
      return rejectedNotification(transport, "missing-start-time", message, fields);
    }

    return {
      status: "accepted",
      transport,
      candidate: {
        title,
        scheduledAt,
        receivedAt,
        source: "outlook-notification",
        transport,
      },
    };
  }

  if (message.signature !== PORTAL_ADD_SIGNATURE) {
    return rejectedNotification(transport, "invalid-signature", message);
  }
  if (!Array.isArray(message.body) || message.body.length < 2) {
    return rejectedNotification(transport, "invalid-body", message);
  }

  const notification = message.body[1];
  const title = sanitizeMeetingTitle(getDictValue(notification, "title"));
  const rawBodies = [
    getDictValue(notification, "body"),
    getDictValue(notification, "markup-body"),
  ].filter((value) => typeof value === "string");
  const scheduledAt =
    rawBodies.map((value) => parseMeetingStartTime(value, receivedAt)).find(Number.isFinite) ??
    null;
  const fieldNames = Array.isArray(notification)
    ? notification
        .filter((entry) => Array.isArray(entry) && typeof entry[0] === "string")
        .map((entry) => entry[0])
    : [];
  const fields = {
    hasTitle: title !== null,
    hasBody: rawBodies.length > 0,
    hasRecognizedStartTime: scheduledAt !== null,
    hasEdgeDesktopEntry: getDictValue(notification, "desktop-entry") === EDGE_DESKTOP_ENTRY,
    hasOutlookOrigin: OUTLOOK_ORIGINS.has(getDictValue(notification, "x-kde-origin-name")),
    unknownFieldCount: fieldNames.filter((key) => !PORTAL_KNOWN_FIELDS.has(key)).length,
  };

  if (!fields.hasEdgeDesktopEntry || !fields.hasOutlookOrigin) {
    return rejectedNotification(transport, "unattributed-portal", message, fields);
  }
  if (!title) {
    return rejectedNotification(transport, "missing-title", message, fields);
  }
  if (scheduledAt === null) {
    return rejectedNotification(transport, "missing-start-time", message, fields);
  }

  return {
    status: "accepted",
    transport,
    candidate: {
      title,
      scheduledAt,
      receivedAt,
      source: "outlook-notification",
      transport,
    },
  };
}

function parseOutlookNotificationMessage(message, receivedAt) {
  const result = inspectOutlookNotificationMessage(message, receivedAt);
  return result.status === "accepted" ? result.candidate : null;
}

class LinuxOutlookNotificationMonitor {
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this.desktop = options.desktop ?? process.env.XDG_CURRENT_DESKTOP ?? "";
    this.busAddress = options.busAddress ?? process.env.DBUS_SESSION_BUS_ADDRESS ?? "";
    this.hasExplicitBusAddress = Object.prototype.hasOwnProperty.call(options, "busAddress");
    this.now = options.now ?? (() => Date.now());
    this.createConnection = options.createConnection ?? null;
    this.setTimeout = options.setTimeout ?? setTimeout;
    this.clearTimeout = options.clearTimeout ?? clearTimeout;
    this.phaseSetTimeout = options.phaseSetTimeout ?? setTimeout;
    this.phaseClearTimeout = options.phaseClearTimeout ?? clearTimeout;
    this.connection = null;
    this.enabled = false;
    this.monitoring = false;
    this.retryTimer = null;
    this.phaseTimer = null;
    this.retryDelayMs = INITIAL_RETRY_MS;
    this.connectionGeneration = 0;
    this.connectionPhase = null;
    this.connectionAddressIndex = null;
    this.connectionAddresses = null;
    this.candidates = [];
    this.nextCandidateId = 1;
    this.diagnosticState = new Map();
  }

  isSupported() {
    const desktopTokens = this.desktop
      .split(":")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean);
    return this.platform === "linux" && desktopTokens.includes("kde");
  }

  start() {
    if (this.enabled || !this.isSupported()) return;
    this.enabled = true;
    this._connect();
  }

  stop() {
    this.enabled = false;
    this.monitoring = false;
    this.candidates = [];
    this.diagnosticState.clear();
    this.retryDelayMs = INITIAL_RETRY_MS;
    if (this.retryTimer) {
      this.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this._disposeConnection();
  }

  getBestCandidate(at = this.now()) {
    this._pruneCandidates(at);
    const eligible = this.candidates.filter((candidate) => {
      const offset = at - candidate.scheduledAt;
      return offset >= -MATCH_BEFORE_MS && offset <= MATCH_AFTER_MS;
    });
    if (eligible.length === 0) {
      this._recordRateLimitedDiagnostic(
        "selection:none",
        "debug",
        "Outlook meeting notification candidate selection",
        {
          candidateCount: this.candidates.length,
          eligibleCount: 0,
          selection: "none",
        },
        at
      );
      return null;
    }

    const started = eligible.filter((candidate) => candidate.scheduledAt <= at);
    const selectionBucket = started.length > 0 ? "started" : "upcoming";
    const ranked = started.length > 0 ? started : eligible;
    ranked.sort((left, right) => {
      if (selectionBucket === "started") {
        const receiptOrder = right.receivedAt - left.receivedAt;
        if (receiptOrder) return receiptOrder;
        const distanceOrder = Math.abs(at - left.scheduledAt) - Math.abs(at - right.scheduledAt);
        if (distanceOrder) return distanceOrder;
      } else {
        const scheduleOrder = left.scheduledAt - right.scheduledAt;
        if (scheduleOrder) return scheduleOrder;
        const receiptOrder = right.receivedAt - left.receivedAt;
        if (receiptOrder) return receiptOrder;
      }
      return (left.id ?? Number.MAX_SAFE_INTEGER) - (right.id ?? Number.MAX_SAFE_INTEGER);
    });
    const selected = ranked[0];
    this._recordRateLimitedDiagnostic(
      `selection:${selectionBucket}`,
      "debug",
      "Outlook meeting notification candidate selection",
      {
        candidateCount: this.candidates.length,
        eligibleCount: eligible.length,
        selection: selectionBucket,
        scheduledOffsetMinutes: Math.round((at - selected.scheduledAt) / 60000),
        receiptAgeSeconds: Math.round((at - selected.receivedAt) / 1000),
        transport: selected.transport ?? "freedesktop",
      },
      at
    );
    return { ...selected };
  }

  consumeCandidate(id) {
    if (id === null || id === undefined) return false;
    const candidateIndex = this.candidates.findIndex((candidate) => candidate.id === id);
    if (candidateIndex < 0) return false;
    this.candidates.splice(candidateIndex, 1);
    debugLogger.debug(
      "Outlook meeting notification candidate consumed",
      { candidateCount: this.candidates.length },
      "meeting"
    );
    return true;
  }

  reconnect() {
    if (!this.enabled || !this.isSupported()) return false;
    this._pruneCandidates(this.now());
    if (this.retryTimer) {
      this.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryDelayMs = INITIAL_RETRY_MS;
    this.monitoring = false;
    this._disposeConnection();
    debugLogger.info(
      "Reconnecting Outlook notification title monitor",
      { candidateCount: this.candidates.length },
      "meeting"
    );
    this._connect();
    return true;
  }

  _connect(addressIndex = 0) {
    if (!this.enabled || this.connection) return;

    let createConnection = this.createConnection;
    const useBusAddress = !createConnection || this.hasExplicitBusAddress;
    let addresses = null;
    if (useBusAddress) {
      if (!isLocalSessionBusAddress(this.busAddress)) {
        const error = new Error("Unsupported session D-Bus transport");
        error.code = "UNSUPPORTED_DBUS_TRANSPORT";
        this._handleConnectionFailure(error);
        return;
      }
      addresses = this.busAddress.split(";");
    }
    if (!createConnection) {
      try {
        createConnection = require("@homebridge/dbus-native").createConnection;
      } catch (error) {
        this._handleConnectionFailure(error);
        return;
      }
    }

    this.connectionAddresses = addresses;
    this.connectionAddressIndex = addresses ? addressIndex : null;
    this.connectionPhase = "connect";

    let connection;
    try {
      connection = addresses
        ? createConnection({ busAddress: addresses[addressIndex] })
        : createConnection();
    } catch (error) {
      this._handleConnectionFailure(error);
      return;
    }

    this.connection = connection;
    this.monitoring = false;
    const generation = ++this.connectionGeneration;
    this._startPhaseDeadline("connect", generation);

    connection.on("connect", () => {
      if (!this._isCurrentConnection(connection, generation)) return;
      this._clearPhaseDeadline();
      this.connectionPhase = "hello";
      connection.message({
        type: METHOD_CALL,
        serial: HELLO_SERIAL,
        path: DBUS_PATH,
        destination: DBUS_DESTINATION,
        interface: DBUS_INTERFACE,
        member: "Hello",
      });
      this._startPhaseDeadline("hello", generation);
    });
    connection.on("message", (message) => {
      if (!this._isCurrentConnection(connection, generation)) return;
      this._handleMessage(message);
    });
    connection.on("error", (error) => {
      if (!this._isCurrentConnection(connection, generation)) return;
      this._handleConnectionFailure(error);
    });
    connection.on("end", () => {
      if (!this._isCurrentConnection(connection, generation)) return;
      this._handleConnectionFailure(new Error("D-Bus connection ended"));
    });
  }

  _isCurrentConnection(connection, generation) {
    return this.connection === connection && this.connectionGeneration === generation;
  }

  _handleMessage(message) {
    if (message?.replySerial === HELLO_SERIAL) {
      if (message.type === ERROR) {
        this._handleConnectionFailure(createDbusReplyError(message, "D-Bus Hello failed"));
        return;
      }
      if (message.type !== METHOD_RETURN) return;
      this._clearPhaseDeadline();
      this.connectionPhase = "monitor";
      this.connection.message({
        type: METHOD_CALL,
        serial: MONITOR_SERIAL,
        path: DBUS_PATH,
        destination: DBUS_DESTINATION,
        interface: DBUS_MONITORING_INTERFACE,
        member: "BecomeMonitor",
        signature: "asu",
        body: [NOTIFICATION_MATCH_RULES, 0],
      });
      this._startPhaseDeadline("monitor", this.connectionGeneration);
      return;
    }

    if (message?.replySerial === MONITOR_SERIAL) {
      if (message.type === ERROR) {
        this._handleConnectionFailure(
          createDbusReplyError(message, "D-Bus notification monitoring was denied")
        );
        return;
      }
      if (message.type === METHOD_RETURN) {
        this._clearPhaseDeadline();
        this.connectionPhase = "ready";
        this.monitoring = true;
        this.retryDelayMs = INITIAL_RETRY_MS;
        debugLogger.info(
          "Outlook notification title monitor started",
          { transports: ["freedesktop", "portal"] },
          "meeting"
        );
      }
      return;
    }

    if (!this.monitoring) return;
    const receivedAt = this.now();
    const result = inspectOutlookNotificationMessage(message, receivedAt);
    if (result.status === "accepted") {
      this._cacheCandidate(result.candidate);
    } else if (result.status === "rejected") {
      this._recordRejectedNotification(result, receivedAt);
    }
  }

  _cacheCandidate(candidate) {
    this._pruneCandidates(candidate.receivedAt);
    const duplicateIndex = this.candidates.findIndex(
      (existing) =>
        existing.scheduledAt === candidate.scheduledAt && existing.title === candidate.title
    );
    const duplicate = duplicateIndex >= 0 ? this.candidates.splice(duplicateIndex, 1)[0] : null;
    this.candidates.unshift({
      ...candidate,
      id: duplicate?.id ?? this.nextCandidateId++,
    });
    if (this.candidates.length > MAX_CANDIDATES) {
      this.candidates.length = MAX_CANDIDATES;
    }
    this._recordRateLimitedDiagnostic(
      `cache:${candidate.transport ?? "freedesktop"}`,
      "info",
      "Outlook meeting notification context cached",
      {
        candidateCount: this.candidates.length,
        transport: candidate.transport ?? "freedesktop",
      },
      candidate.receivedAt
    );
  }

  _recordRejectedNotification(result, at) {
    this._recordRateLimitedDiagnostic(
      `rejection:${result.transport}:${result.reason}`,
      "debug",
      "Outlook notification message rejected",
      {
        transport: result.transport,
        reason: result.reason,
        ...result.diagnostics,
      },
      at
    );
  }

  _recordRateLimitedDiagnostic(key, level, message, details, at) {
    const previous = this.diagnosticState.get(key);
    if (previous && at - previous.lastLoggedAt < DIAGNOSTIC_INTERVAL_MS) {
      previous.suppressedCount += 1;
      return;
    }

    debugLogger[level](
      message,
      {
        ...details,
        suppressedSinceLastLog: previous?.suppressedCount ?? 0,
      },
      "meeting"
    );
    this.diagnosticState.set(key, { lastLoggedAt: at, suppressedCount: 0 });
  }

  _pruneCandidates(at) {
    this.candidates = this.candidates.filter(
      (candidate) => candidate.scheduledAt + MATCH_AFTER_MS >= at
    );
  }

  _handleConnectionFailure(error, retry = !isPermanentConnectionError(error)) {
    if (!this.enabled) return;
    const nextAddressIndex =
      retry &&
      this.connectionPhase === "connect" &&
      this.connectionAddresses &&
      this.connectionAddressIndex + 1 < this.connectionAddresses.length
        ? this.connectionAddressIndex + 1
        : null;
    debugLogger.warn(
      "Outlook notification title monitor unavailable",
      {
        failureType: retry ? "transient-connection" : "permanent-access",
        retrying: retry,
      },
      "meeting"
    );
    this.monitoring = false;
    this._disposeConnection();
    if (nextAddressIndex !== null) {
      this._connect(nextAddressIndex);
    } else if (retry) {
      this._scheduleReconnect();
    }
  }

  _disposeConnection() {
    this._clearPhaseDeadline();
    const connection = this.connection;
    this.connection = null;
    this.connectionPhase = null;
    this.connectionAddressIndex = null;
    this.connectionAddresses = null;
    this.connectionGeneration += 1;
    if (!connection) return;
    connection.removeAllListeners();
    connection.on("error", () => {});
    try {
      connection.end();
    } catch {}
  }

  _startPhaseDeadline(phase, generation) {
    this._clearPhaseDeadline();
    let timer;
    timer = this.phaseSetTimeout(() => {
      if (this.phaseTimer !== timer || !this.enabled || this.connectionGeneration !== generation) {
        return;
      }
      this.phaseTimer = null;
      const error = new Error("D-Bus connection phase timed out");
      error.code = "DBUS_PHASE_TIMEOUT";
      error.phase = phase;
      this._handleConnectionFailure(error);
    }, CONNECTION_PHASE_TIMEOUT_MS);
    this.phaseTimer = timer;
    timer?.unref?.();
  }

  _clearPhaseDeadline() {
    if (this.phaseTimer === null) return;
    this.phaseClearTimeout(this.phaseTimer);
    this.phaseTimer = null;
  }

  _scheduleReconnect() {
    if (!this.enabled || this.retryTimer) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_MS);
    this.retryTimer = this.setTimeout(() => {
      this.retryTimer = null;
      this._connect();
    }, delay);
  }
}

module.exports = {
  CONNECTION_PHASE_TIMEOUT_MS,
  EDGE_APP_NAME,
  MATCH_AFTER_MS,
  MATCH_BEFORE_MS,
  NOTIFICATION_MATCH_RULE,
  NOTIFICATION_MATCH_RULES,
  OUTLOOK_ORIGIN,
  PORTAL_NOTIFICATION_MATCH_RULE,
  LinuxOutlookNotificationMonitor,
  inspectOutlookNotificationMessage,
  isLocalSessionBusAddress,
  isPermanentConnectionError,
  parseOutlookNotificationMessage,
  parseMeetingStartTime,
  sanitizeMeetingTitle,
  unwrapDbusVariant,
};
