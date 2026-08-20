const ELMS_ORIGIN = "https://elms.uiu.ac.bd";
const MY_COURSES_URL = `${ELMS_ORIGIN}/my/courses.php`;
const LOGIN_URL = `${ELMS_ORIGIN}/login/index.php`;
const UPCOMING_CALENDAR_URL = `${ELMS_ORIGIN}/calendar/view.php?view=upcoming`;
const ALARM_NAME = "uiu-elms-announcement-check";
const ASSIGNMENT_REMINDER_ALARM = "uiu-elms-assignment-reminder";

const DEFAULT_SETTINGS = {
  intervalMinutes: 5,
  notificationsEnabled: true,
  assignmentReminderMinutes: 60
};

const MAX_STORED_ANNOUNCEMENTS = 300;
const MAX_STORED_ASSIGNMENTS = 100;
const MAX_DISCUSSIONS_PER_COURSE = 30;
const DETAIL_PREFETCH_PER_COURSE = 8;
const NOTIFICATION_TARGET_LIMIT = 80;

let checkInProgress = false;
let creatingOffscreen = null;
let lastPageTriggeredCheck = 0;

class LoginRequiredError extends Error {
  constructor(message = "UIU eLMS login is required.") {
    super(message);
    this.name = "LoginRequiredError";
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await initializeState();
  await ensureAlarm();
  await scheduleNextAssignmentReminder();
  await updateActionBadge();

  checkAllCourses({ source: "installed" }).catch(console.error);
});

chrome.runtime.onStartup.addListener(async () => {
  await initializeState();
  await ensureAlarm();
  await scheduleNextAssignmentReminder();
  await updateActionBadge();

  checkAllCourses({ source: "startup" }).catch(console.error);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkAllCourses({ source: "alarm" }).catch(console.error);
  } else if (alarm.name === ASSIGNMENT_REMINDER_ALARM) {
    processAssignmentReminders().catch(console.error);
  }
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const { notificationTargets = {} } =
    await chrome.storage.local.get("notificationTargets");

  const target = notificationTargets[notificationId];
  if (!target) return;

  if (target.announcementKey) {
    await markAnnouncementRead(target.announcementKey);
  }

  if (target.assignmentKey) {
    await markAssignmentRead(target.assignmentKey);
  }

  if (target.url) {
    await chrome.tabs.create({ url: target.url });
  }

  chrome.notifications.clear(notificationId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages intended for the offscreen parser should be answered by
  // offscreen.js, not by this service worker.
  if (message?.target === "offscreen") {
    return false;
  }

  (async () => {
    switch (message?.type) {
      case "COURSES_DISCOVERED":
        return await handleDiscoveredCourses(message.courses || []);

      case "ELMS_PAGE_ACTIVE":
        return triggerCheckFromElmsPage(message.url);

      case "CHECK_NOW":
        return await checkAllCourses({ source: "manual" });

      case "MARK_READ":
        await markAnnouncementRead(message.key);
        return { ok: true };

      case "MARK_ALL_READ":
        await markAllItemsRead();
        return { ok: true };

      case "MARK_ASSIGNMENT_READ":
        await markAssignmentRead(message.key);
        return { ok: true };

      case "SAVE_SETTINGS":
        return await saveSettings(message.settings || {});

      case "GET_STATE":
        return await getPublicState();

      default:
        return { ok: false, error: "Unknown message." };
    }
  })()
    .then(sendResponse)
    .catch((error) => {
      console.error("UIU eLMS Watcher message error:", error);
      sendResponse({
        ok: false,
        error: error?.message || "Unexpected extension error."
      });
    });

  return true;
});

async function initializeState() {
  const stored = await chrome.storage.local.get([
    "settings",
    "courses",
    "announcements",
    "assignments",
    "assignmentsInitialized",
    "courseInitialized",
    "lastChecked",
    "status",
    "notificationTargets"
  ]);

  const updates = {};

  if (!stored.settings) updates.settings = DEFAULT_SETTINGS;
  if (!Array.isArray(stored.courses)) updates.courses = [];
  if (!Array.isArray(stored.announcements)) updates.announcements = [];
  if (!Array.isArray(stored.assignments)) updates.assignments = [];
  if (typeof stored.assignmentsInitialized !== "boolean") {
    updates.assignmentsInitialized = false;
  }
  if (!stored.courseInitialized) updates.courseInitialized = {};
  if (!stored.status) updates.status = "setup_required";
  if (!stored.notificationTargets) updates.notificationTargets = {};

  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
  }
}

function triggerCheckFromElmsPage(pageUrl) {
  try {
    const url = new URL(pageUrl);
    if (url.origin !== ELMS_ORIGIN || url.pathname === "/login/index.php") {
      return { ok: true, scheduled: false };
    }
  } catch {
    return { ok: false, error: "Invalid eLMS page URL." };
  }

  const now = Date.now();
  if (checkInProgress || now - lastPageTriggeredCheck < 30000) {
    return { ok: true, scheduled: false };
  }

  lastPageTriggeredCheck = now;
  checkAllCourses({ source: "elms_page" }).catch(console.error);
  return { ok: true, scheduled: true };
}

async function ensureAlarm() {
  const { settings = DEFAULT_SETTINGS } =
    await chrome.storage.local.get("settings");

  const interval = sanitizeInterval(settings.intervalMinutes);
  const existing = await chrome.alarms.get(ALARM_NAME);

  if (
    !existing ||
    Number(existing.periodInMinutes) !== Number(interval)
  ) {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: interval,
      periodInMinutes: interval
    });
  }
}

async function saveSettings(partial) {
  const { settings = DEFAULT_SETTINGS } =
    await chrome.storage.local.get("settings");

  const next = {
    ...DEFAULT_SETTINGS,
    ...settings,
    ...partial,
    intervalMinutes: sanitizeInterval(
      partial.intervalMinutes ?? settings.intervalMinutes
    ),
    notificationsEnabled:
      partial.notificationsEnabled ??
      settings.notificationsEnabled ??
      true,
    assignmentReminderMinutes: sanitizeReminderMinutes(
      partial.assignmentReminderMinutes ?? settings.assignmentReminderMinutes
    )
  };

  await chrome.storage.local.set({ settings: next });
  await ensureAlarm();
  await scheduleNextAssignmentReminder();

  return { ok: true, settings: next };
}

function sanitizeInterval(value) {
  const allowed = [1, 2, 5, 10, 15, 30, 60];
  const parsed = Number(value);
  return allowed.includes(parsed) ? parsed : 5;
}

function sanitizeReminderMinutes(value) {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 10080
    ? parsed
    : 60;
}

async function handleDiscoveredCourses(discoveredCourses) {
  const cleaned = normalizeCourses(discoveredCourses);

  if (!cleaned.length) {
    return { ok: false, error: "No course links were found yet." };
  }

  const { courses: existingCourses = [] } =
    await chrome.storage.local.get("courses");

  const existingMap = new Map(
    existingCourses.map((course) => [String(course.id), course])
  );

  const merged = cleaned.map((course) => ({
    ...existingMap.get(String(course.id)),
    ...course,
    active: true
  }));

  // Keep manually/previously discovered courses in case Moodle temporarily
  // renders only part of the course list.
  for (const existing of existingCourses) {
    if (!merged.some((course) => String(course.id) === String(existing.id))) {
      merged.push(existing);
    }
  }

  await chrome.storage.local.set({
    courses: merged,
    status: "ready"
  });

  // The first discovery should establish the baseline immediately.
  checkAllCourses({ source: "course_discovery" }).catch(console.error);

  return { ok: true, courses: merged };
}

function normalizeCourses(courses) {
  const map = new Map();

  for (const raw of courses) {
    if (!raw?.id) continue;

    const id = String(raw.id).trim();
    if (!/^\d+$/.test(id) || id === "1") continue;

    const url = `${ELMS_ORIGIN}/course/view.php?id=${encodeURIComponent(id)}`;
    const name = cleanText(raw.name) || `Course ${id}`;

    const current = map.get(id);
    if (!current || name.length > current.name.length) {
      map.set(id, { id, name, url, active: true });
    }
  }

  return [...map.values()];
}

async function discoverCoursesAutomatically() {
  const html = await fetchPage(MY_COURSES_URL);
  const config = extractMoodleConfig(html);
  const pageResult = await parseWithOffscreen("PARSE_COURSE_LIST", {
    html,
    baseUrl: MY_COURSES_URL
  });

  let discovered = normalizeCourses(pageResult?.courses || []);

  if (config.sesskey) {
    try {
      const apiCourses = normalizeCourses(
        await fetchEnrolledCourses(config.sesskey)
      );
      if (apiCourses.length) discovered = apiCourses;
    } catch (error) {
      // Some Moodle installations restrict this AJAX method. The server-
      // rendered course links remain a valid fallback.
      console.warn("Automatic course API discovery failed:", error);
    }
  }

  const stored = await chrome.storage.local.get(["courses", "elmsUserId"]);
  const previousUserId = cleanNumericId(stored.elmsUserId);
  const currentUserId = cleanNumericId(config.userId);
  const accountChanged = Boolean(
    previousUserId && currentUserId && previousUserId !== currentUserId
  );
  const existingCourses = accountChanged
    ? []
    : Array.isArray(stored.courses)
      ? stored.courses
      : [];
  const existingMap = new Map(
    existingCourses.map((course) => [String(course.id), course])
  );
  const courses = discovered.length
    ? discovered.map((course) => ({
        ...existingMap.get(String(course.id)),
        ...course,
        active: true
      }))
    : existingCourses;

  const updates = {
    courses,
    status: "ready",
    lastError: null
  };
  if (currentUserId) updates.elmsUserId = currentUserId;

  if (accountChanged) {
    // Never mix notifications or saved items between two eLMS accounts.
    Object.assign(updates, {
      announcements: [],
      assignments: [],
      courseInitialized: {},
      assignmentsInitialized: false,
      notificationTargets: {}
    });
  }

  await chrome.storage.local.set(updates);
  return courses;
}

function extractMoodleConfig(html) {
  const source = String(html || "");
  return {
    sesskey:
      source.match(/(?:"sesskey"|sesskey)\s*:\s*["']([^"']+)["']/i)?.[1] ||
      null,
    userId:
      source.match(/(?:"userId"|userId)\s*:\s*["']?(\d+)/i)?.[1] ||
      null
  };
}

async function fetchEnrolledCourses(sesskey) {
  const method = "core_course_get_enrolled_courses_by_timeline_classification";
  const url =
    `${ELMS_ORIGIN}/lib/ajax/service.php` +
    `?sesskey=${encodeURIComponent(sesskey)}` +
    `&info=${encodeURIComponent(method)}`;
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify([
      {
        index: 0,
        methodname: method,
        args: {
          offset: 0,
          limit: 0,
          classification: "all",
          sort: "fullname",
          customfieldname: "",
          customfieldvalue: ""
        }
      }
    ])
  });

  if (!response.ok) {
    throw new Error(`Course discovery returned HTTP ${response.status}.`);
  }

  const payload = await response.json();
  const result = Array.isArray(payload) ? payload[0] : null;
  if (result?.error || result?.exception) {
    throw new Error(
      result.error?.message ||
      result.exception?.message ||
      "Course discovery was rejected by eLMS."
    );
  }

  const courses = result?.data?.courses || result?.data || [];
  if (!Array.isArray(courses)) return [];

  return courses.map((course) => ({
    id: course.id,
    name:
      course.displayname ||
      course.fullname ||
      course.shortname ||
      `Course ${course.id}`
  }));
}

async function checkAllCourses({ source = "unknown" } = {}) {
  if (checkInProgress) {
    return {
      ok: false,
      busy: true,
      error: "A check is already running."
    };
  }

  checkInProgress = true;
  await chrome.storage.local.set({ checking: true });

  try {
    await initializeState();
    await discoverCoursesAutomatically();

    const stored = await chrome.storage.local.get([
      "courses",
      "announcements",
      "assignments",
      "assignmentsInitialized",
      "courseInitialized",
      "settings"
    ]);

    const courses = Array.isArray(stored.courses) ? stored.courses : [];
    let announcements = Array.isArray(stored.announcements)
      ? stored.announcements
      : [];
    let assignments = Array.isArray(stored.assignments)
      ? stored.assignments
      : [];
    let assignmentsInitialized = stored.assignmentsInitialized === true;
    const courseInitialized = stored.courseInitialized || {};
    const settings = {
      ...DEFAULT_SETTINGS,
      ...(stored.settings || {})
    };

    const existingMap = new Map(
      announcements.map((announcement) => [announcement.key, announcement])
    );

    const updatedCourses = [];
    const newlyFound = [];
    let newlyFoundAssignments = [];
    let assignmentError = null;
    let loginRequired = false;

    for (const course of courses) {
      try {
        const result = await checkSingleCourse(
          course,
          existingMap,
          courseInitialized
        );

        updatedCourses.push(result.course);

        for (const announcement of result.announcements) {
          existingMap.set(announcement.key, announcement);
        }

        newlyFound.push(...result.newlyFound);
        courseInitialized[String(course.id)] = true;
      } catch (error) {
        if (error instanceof LoginRequiredError) {
          loginRequired = true;
          updatedCourses.push({
            ...course,
            lastError: "Login required",
            lastChecked: Date.now()
          });
          break;
        }

        console.error(`Course ${course.id} check failed`, error);
        updatedCourses.push({
          ...course,
          lastError: error?.message || "Could not check this course.",
          lastChecked: Date.now()
        });
      }
    }

    announcements = [...existingMap.values()]
      .sort(sortAnnouncementsNewestFirst)
      .slice(0, MAX_STORED_ANNOUNCEMENTS);

    if (!loginRequired) {
      try {
        const assignmentResult = await checkUpcomingAssignments(
          assignments,
          assignmentsInitialized,
          courses
        );
        assignments = assignmentResult.assignments;
        newlyFoundAssignments = assignmentResult.newlyFound;
        assignmentsInitialized = true;
      } catch (error) {
        if (error instanceof LoginRequiredError) {
          loginRequired = true;
        } else {
          assignmentError = error?.message || "Could not check assignments.";
          console.error("Assignment check failed", error);
        }
      }
    }

    const now = Date.now();
    const status = loginRequired ? "login_required" : "ready";

    await chrome.storage.local.set({
      courses: mergeCourseCheckResults(courses, updatedCourses),
      announcements,
      assignments,
      assignmentsInitialized,
      courseInitialized,
      lastChecked: now,
      status,
      lastError: loginRequired ? "Please sign in to UIU eLMS." : null,
      lastAssignmentError: assignmentError
    });

    await updateActionBadge();

    if (!loginRequired && settings.notificationsEnabled && newlyFound.length) {
      await notifyNewAnnouncements(newlyFound);
    }

    if (
      !loginRequired &&
      settings.notificationsEnabled &&
      newlyFoundAssignments.length
    ) {
      await notifyNewAssignments(newlyFoundAssignments);
    }

    await scheduleNextAssignmentReminder();

    return {
      ok: !loginRequired,
      status,
      source,
      newCount: newlyFound.length + newlyFoundAssignments.length,
      checkedAt: now
    };
  } catch (error) {
    console.error("UIU eLMS Watcher check failed:", error);

    await chrome.storage.local.set({
      lastChecked: Date.now(),
      status:
        error instanceof LoginRequiredError ? "login_required" : "error",
      lastError: error?.message || "Announcement check failed."
    });

    return {
      ok: false,
      status:
        error instanceof LoginRequiredError ? "login_required" : "error",
      error: error?.message || "Announcement check failed."
    };
  } finally {
    checkInProgress = false;
    await chrome.storage.local.set({ checking: false });
  }
}

async function checkSingleCourse(course, existingMap, courseInitialized) {
  const checkedAt = Date.now();

  const courseHtml = await fetchPage(course.url);
  const courseParse = await parseWithOffscreen("PARSE_COURSE", {
    html: courseHtml,
    baseUrl: course.url
  });

  if (!courseParse?.announcementForumUrl) {
    return {
      course: {
        ...course,
        announcementForumUrl: null,
        lastChecked: checkedAt,
        lastError: null,
        announcementStatus: "not_found"
      },
      announcements: [],
      newlyFound: []
    };
  }

  const forumUrl = courseParse.announcementForumUrl;
  const forumHtml = await fetchPage(forumUrl);
  const forumParse = await parseWithOffscreen("PARSE_FORUM", {
    html: forumHtml,
    baseUrl: forumUrl
  });

  const discussions = (forumParse?.discussions || [])
    .slice(0, MAX_DISCUSSIONS_PER_COURSE);

  const isBaselineRun = !courseInitialized[String(course.id)];
  const announcements = [];
  const newlyFound = [];
  const detailCandidates = [];

  for (let index = 0; index < discussions.length; index++) {
    const discussion = discussions[index];
    const key = `${course.id}:${discussion.id}`;
    const existing = existingMap.get(key);

    let announcement;

    if (existing) {
      announcement = {
        ...existing,
        title: chooseBetterText(existing.title, discussion.title),
        author: chooseBetterText(existing.author, discussion.author),
        dateText: chooseBetterText(existing.dateText, discussion.dateText),
        postedAt:
          existing.postedAt ||
          parseDateValue(discussion.dateText) ||
          null,
        url: discussion.url,
        forumUrl,
        courseId: String(course.id),
        courseName: course.name,
        lastSeenAt: checkedAt
      };
    } else {
      announcement = {
        key,
        discussionId: String(discussion.id),
        courseId: String(course.id),
        courseName: course.name,
        title: cleanText(discussion.title) || "Announcement",
        author: cleanText(discussion.author),
        dateText: cleanText(discussion.dateText),
        postedAt: parseDateValue(discussion.dateText),
        excerpt: "",
        url: discussion.url,
        forumUrl,
        isNew: !isBaselineRun,
        firstSeenAt: checkedAt,
        lastSeenAt: checkedAt
      };

      if (!isBaselineRun) {
        newlyFound.push(announcement);
      }
    }

    announcements.push(announcement);

    if (
      !announcement.excerpt &&
      (index < DETAIL_PREFETCH_PER_COURSE || announcement.isNew)
    ) {
      detailCandidates.push(announcement);
    }
  }

  // Fetch a few discussion pages so the popup can display actual announcement
  // text, not just forum topic titles.
  await mapWithConcurrency(detailCandidates, 3, async (announcement) => {
    try {
      const html = await fetchPage(announcement.url);
      const detail = await parseWithOffscreen("PARSE_DISCUSSION", {
        html,
        baseUrl: announcement.url
      });

      if (detail) {
        announcement.title = chooseBetterText(
          announcement.title,
          detail.title
        );
        announcement.author = chooseBetterText(
          announcement.author,
          detail.author
        );
        announcement.dateText = chooseBetterText(
          announcement.dateText,
          detail.dateText
        );
        announcement.postedAt =
          announcement.postedAt ||
          parseDateValue(detail.dateText) ||
          null;
        announcement.excerpt =
          cleanText(detail.excerpt).slice(0, 700);
      }
    } catch (error) {
      // A detail failure should not prevent detecting the announcement itself.
      console.warn("Could not fetch announcement detail:", announcement.url, error);
    }
  });

  // Update newlyFound references after detail enrichment.
  const enrichedByKey = new Map(announcements.map((item) => [item.key, item]));
  for (let i = 0; i < newlyFound.length; i++) {
    newlyFound[i] = enrichedByKey.get(newlyFound[i].key) || newlyFound[i];
  }

  return {
    course: {
      ...course,
      announcementForumUrl: forumUrl,
      announcementStatus: "found",
      lastChecked: checkedAt,
      lastError: null
    },
    announcements,
    newlyFound
  };
}

async function checkUpcomingAssignments(
  existingAssignments,
  assignmentsInitialized,
  courses
) {
  const checkedAt = Date.now();
  const html = await fetchPage(UPCOMING_CALENDAR_URL);
  const parsed = await parseWithOffscreen("PARSE_ASSIGNMENTS", {
    html,
    baseUrl: UPCOMING_CALENDAR_URL
  });

  const existingMap = new Map(
    existingAssignments.map((assignment) => [assignment.key, assignment])
  );
  const courseMap = new Map(
    courses.map((course) => [String(course.id), course.name])
  );
  const assignments = [];
  const newlyFound = [];

  for (const raw of parsed?.assignments || []) {
    const dueAt = Number(raw.dueAt);
    if (!Number.isFinite(dueAt) || dueAt <= checkedAt) continue;

    const assignmentId = cleanNumericId(raw.assignmentId);
    const eventId = cleanNumericId(raw.eventId);
    if (!assignmentId && !eventId) continue;

    const key = assignmentId
      ? `assign:${assignmentId}`
      : `calendar-event:${eventId}`;
    const existing = existingMap.get(key);
    const courseId = cleanNumericId(raw.courseId);
    const assignment = {
      ...(existing || {}),
      key,
      assignmentId,
      eventId,
      courseId,
      courseName:
        cleanText(raw.courseName) ||
        courseMap.get(String(courseId)) ||
        existing?.courseName ||
        "UIU eLMS",
      title:
        cleanAssignmentTitle(raw.title) ||
        existing?.title ||
        "Assignment",
      dueAt,
      dueText: cleanText(raw.dueText),
      url: raw.url || existing?.url || UPCOMING_CALENDAR_URL,
      isNew: existing ? Boolean(existing.isNew) : assignmentsInitialized,
      firstSeenAt: existing?.firstSeenAt || checkedAt,
      lastSeenAt: checkedAt
    };

    assignments.push(assignment);
    if (!existing && assignmentsInitialized) newlyFound.push(assignment);
  }

  assignments.sort((a, b) => Number(a.dueAt) - Number(b.dueAt));

  return {
    assignments: assignments.slice(0, MAX_STORED_ASSIGNMENTS),
    newlyFound
  };
}

function cleanNumericId(value) {
  const text = String(value || "").trim();
  return /^\d+$/.test(text) ? text : null;
}

function cleanAssignmentTitle(value) {
  return cleanText(value)
    .replace(/\s+(?:is\s+)?due\s*$/i, "")
    .replace(/\s*[—–-]\s*assignment\s*$/i, "")
    .trim();
}

function mergeCourseCheckResults(originalCourses, checkedCourses) {
  const checkedMap = new Map(
    checkedCourses.map((course) => [String(course.id), course])
  );

  return originalCourses.map(
    (course) => checkedMap.get(String(course.id)) || course
  );
}

async function fetchPage(url) {
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    redirect: "follow",
    headers: {
      "Accept": "text/html,application/xhtml+xml"
    }
  });

  const html = await response.text();

  if (!response.ok) {
    throw new Error(`eLMS returned HTTP ${response.status}.`);
  }

  if (looksLikeLoginPage(response.url, html)) {
    throw new LoginRequiredError();
  }

  return html;
}

function looksLikeLoginPage(finalUrl, html) {
  if (/\/login\/index\.php/i.test(finalUrl)) return true;

  const sample = html.slice(0, 120000);
  return (
    /id=["']login["']/i.test(sample) &&
    /name=["']username["']/i.test(sample) &&
    /name=["']password["']/i.test(sample)
  );
}

async function parseWithOffscreen(type, payload) {
  if (chrome.offscreen?.createDocument) {
    await ensureOffscreenDocument();
  }

  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type,
    ...payload
  });

  if (!response?.ok) {
    throw new Error(response?.error || "HTML parsing failed.");
  }

  return response.data;
}

async function ensureOffscreenDocument() {
  const path = "offscreen.html";
  const url = chrome.runtime.getURL(path);

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });

  if (contexts.length) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: path,
    reasons: ["DOM_PARSER"],
    justification:
      "Parse UIU eLMS course, forum, and calendar HTML to detect announcements and assignment deadlines."
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function notifyNewAnnouncements(announcements) {
  const { notificationTargets = {} } =
    await chrome.storage.local.get("notificationTargets");

  for (const announcement of announcements.slice(0, 8)) {
    const notificationId = `uiu-elms:${announcement.key}:${Date.now()}`;

    notificationTargets[notificationId] = {
      url: announcement.url,
      announcementKey: announcement.key,
      createdAt: Date.now()
    };

    await chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "New eLMS announcement",
      message: `${announcement.courseName}\n${announcement.title || "New announcement"}`,
      contextMessage: "UIU eLMS",
      priority: 2
    });
  }

  // Keep the notification target map small.
  const compact = Object.fromEntries(
    Object.entries(notificationTargets)
      .sort((a, b) => (b[1]?.createdAt || 0) - (a[1]?.createdAt || 0))
      .slice(0, NOTIFICATION_TARGET_LIMIT)
  );

  await chrome.storage.local.set({ notificationTargets: compact });
}

async function notifyNewAssignments(assignments) {
  const { notificationTargets = {} } =
    await chrome.storage.local.get("notificationTargets");

  for (const assignment of assignments.slice(0, 8)) {
    const notificationId = `uiu-elms:assignment:${assignment.key}:${Date.now()}`;
    notificationTargets[notificationId] = {
      url: assignment.url,
      assignmentKey: assignment.key,
      createdAt: Date.now()
    };

    await chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "New eLMS assignment",
      message: `${assignment.courseName}\n${assignment.title}`,
      contextMessage: assignment.dueAt
        ? `Due ${formatNotificationDate(assignment.dueAt)}`
        : "UIU eLMS",
      priority: 2
    });
  }

  await saveNotificationTargets(notificationTargets);
}

async function processAssignmentReminders() {
  const stored = await chrome.storage.local.get([
    "settings",
    "assignments",
    "notificationTargets"
  ]);
  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  const assignments = Array.isArray(stored.assignments)
    ? stored.assignments
    : [];

  if (!settings.notificationsEnabled) {
    await chrome.alarms.clear(ASSIGNMENT_REMINDER_ALARM);
    return;
  }

  const now = Date.now();
  const leadMinutes = sanitizeReminderMinutes(
    settings.assignmentReminderMinutes
  );
  const leadMs = leadMinutes * 60 * 1000;
  const notificationTargets = stored.notificationTargets || {};
  let changed = false;

  for (const assignment of assignments) {
    const dueAt = Number(assignment.dueAt);
    const reminderKey = assignmentReminderKey(assignment, leadMinutes);
    if (
      !dueAt ||
      dueAt <= now ||
      now < dueAt - leadMs ||
      assignment.reminderNotifiedKey === reminderKey
    ) {
      continue;
    }

    const notificationId =
      `uiu-elms:assignment-reminder:${assignment.key}:${Date.now()}`;
    notificationTargets[notificationId] = {
      url: assignment.url,
      assignmentKey: assignment.key,
      createdAt: Date.now()
    };

    await chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: `Assignment due in ${formatLeadTime(leadMinutes)}`,
      message: `${assignment.courseName}\n${assignment.title}`,
      contextMessage: `Due ${formatNotificationDate(dueAt)}`,
      priority: 2,
      requireInteraction: leadMinutes <= 60
    });

    assignment.reminderNotifiedKey = reminderKey;
    assignment.reminderNotifiedAt = now;
    changed = true;
  }

  if (changed) {
    await chrome.storage.local.set({ assignments });
  }
  await saveNotificationTargets(notificationTargets);
  await scheduleNextAssignmentReminder();
}

async function scheduleNextAssignmentReminder() {
  const stored = await chrome.storage.local.get(["settings", "assignments"]);
  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };

  await chrome.alarms.clear(ASSIGNMENT_REMINDER_ALARM);
  if (!settings.notificationsEnabled) return;

  const now = Date.now();
  const leadMinutes = sanitizeReminderMinutes(
    settings.assignmentReminderMinutes
  );
  const leadMs = leadMinutes * 60 * 1000;
  let nextReminderAt = null;

  for (const assignment of stored.assignments || []) {
    const dueAt = Number(assignment.dueAt);
    const reminderKey = assignmentReminderKey(assignment, leadMinutes);
    if (
      !dueAt ||
      dueAt <= now ||
      assignment.reminderNotifiedKey === reminderKey
    ) {
      continue;
    }

    const reminderAt = Math.max(now + 1000, dueAt - leadMs);
    if (nextReminderAt === null || reminderAt < nextReminderAt) {
      nextReminderAt = reminderAt;
    }
  }

  if (nextReminderAt !== null) {
    await chrome.alarms.create(ASSIGNMENT_REMINDER_ALARM, {
      when: nextReminderAt
    });
  }
}

function assignmentReminderKey(assignment, leadMinutes) {
  return `${Number(assignment.dueAt)}:${leadMinutes}`;
}

function formatLeadTime(minutes) {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minutes`;
}

function formatNotificationDate(timestamp) {
  return new Intl.DateTimeFormat("en-BD", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Dhaka"
  }).format(new Date(Number(timestamp)));
}

async function saveNotificationTargets(notificationTargets) {
  const compact = Object.fromEntries(
    Object.entries(notificationTargets)
      .sort((a, b) => (b[1]?.createdAt || 0) - (a[1]?.createdAt || 0))
      .slice(0, NOTIFICATION_TARGET_LIMIT)
  );
  await chrome.storage.local.set({ notificationTargets: compact });
}

async function markAnnouncementRead(key) {
  if (!key) return;

  const { announcements = [] } =
    await chrome.storage.local.get("announcements");

  const updated = announcements.map((announcement) =>
    announcement.key === key
      ? { ...announcement, isNew: false, readAt: Date.now() }
      : announcement
  );

  await chrome.storage.local.set({ announcements: updated });
  await updateActionBadge();
}

async function markAssignmentRead(key) {
  if (!key) return;

  const { assignments = [] } = await chrome.storage.local.get("assignments");
  const updated = assignments.map((assignment) =>
    assignment.key === key
      ? { ...assignment, isNew: false, readAt: Date.now() }
      : assignment
  );

  await chrome.storage.local.set({ assignments: updated });
  await updateActionBadge();
}

async function markAllItemsRead() {
  const { announcements = [], assignments = [] } =
    await chrome.storage.local.get(["announcements", "assignments"]);

  const now = Date.now();
  const updatedAnnouncements = announcements.map((announcement) => ({
    ...announcement,
    isNew: false,
    readAt: announcement.readAt || now
  }));
  const updatedAssignments = assignments.map((assignment) => ({
    ...assignment,
    isNew: false,
    readAt: assignment.readAt || now
  }));

  await chrome.storage.local.set({
    announcements: updatedAnnouncements,
    assignments: updatedAssignments
  });
  await updateActionBadge();
}

async function updateActionBadge() {
  const { announcements = [], assignments = [] } =
    await chrome.storage.local.get(["announcements", "assignments"]);

  const count =
    announcements.filter((announcement) => announcement.isNew).length +
    assignments.filter((assignment) => assignment.isNew).length;

  await chrome.action.setBadgeText({
    text: count ? (count > 99 ? "99+" : String(count)) : ""
  });

  if (count) {
    await chrome.action.setBadgeBackgroundColor({ color: "#4F46E5" });
    await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
  }
}

async function getPublicState() {
  const state = await chrome.storage.local.get([
    "settings",
    "courses",
    "announcements",
    "assignments",
    "lastChecked",
    "status",
    "lastError",
    "lastAssignmentError",
    "checking"
  ]);

  return {
    ok: true,
    ...state
  };
}

function sortAnnouncementsNewestFirst(a, b) {
  const aTime =
    Number(a.postedAt) ||
    Number(a.firstSeenAt) ||
    0;
  const bTime =
    Number(b.postedAt) ||
    Number(b.firstSeenAt) ||
    0;

  return bTime - aTime;
}

function parseDateValue(value) {
  if (!value) return null;

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function chooseBetterText(current, candidate) {
  const a = cleanText(current);
  const b = cleanText(candidate);

  if (!a) return b;
  if (!b) return a;

  // Prefer the richer candidate, unless it looks like generic UI text.
  const generic = /^(announcement|announcements|forum|discussion)$/i;
  if (generic.test(a) && !generic.test(b)) return b;

  return b.length > a.length ? b : a;
}

async function mapWithConcurrency(items, limit, mapper) {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length) {
        const item = queue.shift();
        await mapper(item);
      }
    }
  );

  await Promise.all(workers);
}
