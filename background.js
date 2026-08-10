const ELMS_ORIGIN = "https://elms.uiu.ac.bd";
const MY_COURSES_URL = `${ELMS_ORIGIN}/my/courses.php`;
const LOGIN_URL = `${ELMS_ORIGIN}/login/index.php`;
const ALARM_NAME = "uiu-elms-announcement-check";

const DEFAULT_SETTINGS = {
  intervalMinutes: 5,
  notificationsEnabled: true
};

const MAX_STORED_ANNOUNCEMENTS = 300;
const MAX_DISCUSSIONS_PER_COURSE = 30;
const DETAIL_PREFETCH_PER_COURSE = 8;
const NOTIFICATION_TARGET_LIMIT = 80;

let checkInProgress = false;
let creatingOffscreen = null;

class LoginRequiredError extends Error {
  constructor(message = "UIU eLMS login is required.") {
    super(message);
    this.name = "LoginRequiredError";
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await initializeState();
  await ensureAlarm();
  await updateActionBadge();

  // If courses were already discovered during an extension update/reload,
  // silently refresh them. Otherwise the popup will guide the user.
  const { courses = [] } = await chrome.storage.local.get("courses");
  if (courses.length) {
    checkAllCourses({ source: "installed" }).catch(console.error);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await initializeState();
  await ensureAlarm();
  await updateActionBadge();

  const { courses = [] } = await chrome.storage.local.get("courses");
  if (courses.length) {
    checkAllCourses({ source: "startup" }).catch(console.error);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkAllCourses({ source: "alarm" }).catch(console.error);
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

      case "CHECK_NOW":
        return await checkAllCourses({ source: "manual" });

      case "MARK_READ":
        await markAnnouncementRead(message.key);
        return { ok: true };

      case "MARK_ALL_READ":
        await markAllAnnouncementsRead();
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
    "courseInitialized",
    "lastChecked",
    "status",
    "notificationTargets"
  ]);

  const updates = {};

  if (!stored.settings) updates.settings = DEFAULT_SETTINGS;
  if (!Array.isArray(stored.courses)) updates.courses = [];
  if (!Array.isArray(stored.announcements)) updates.announcements = [];
  if (!stored.courseInitialized) updates.courseInitialized = {};
  if (!stored.status) updates.status = "setup_required";
  if (!stored.notificationTargets) updates.notificationTargets = {};

  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
  }
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
      true
  };

  await chrome.storage.local.set({ settings: next });
  await ensureAlarm();

  return { ok: true, settings: next };
}

function sanitizeInterval(value) {
  const allowed = [1, 2, 5, 10, 15, 30, 60];
  const parsed = Number(value);
  return allowed.includes(parsed) ? parsed : 5;
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

    const stored = await chrome.storage.local.get([
      "courses",
      "announcements",
      "courseInitialized",
      "settings"
    ]);

    const courses = Array.isArray(stored.courses) ? stored.courses : [];
    let announcements = Array.isArray(stored.announcements)
      ? stored.announcements
      : [];
    const courseInitialized = stored.courseInitialized || {};
    const settings = {
      ...DEFAULT_SETTINGS,
      ...(stored.settings || {})
    };

    if (!courses.length) {
      const result = {
        ok: false,
        status: "setup_required",
        error: "Open My Courses once so the extension can discover your enrolled courses."
      };

      await chrome.storage.local.set({
        status: "setup_required",
        lastError: result.error,
        lastChecked: Date.now()
      });

      return result;
    }

    const existingMap = new Map(
      announcements.map((announcement) => [announcement.key, announcement])
    );

    const updatedCourses = [];
    const newlyFound = [];
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

    const now = Date.now();
    const status = loginRequired ? "login_required" : "ready";

    await chrome.storage.local.set({
      courses: mergeCourseCheckResults(courses, updatedCourses),
      announcements,
      courseInitialized,
      lastChecked: now,
      status,
      lastError: loginRequired ? "Please sign in to UIU eLMS." : null
    });

    await updateActionBadge();

    if (!loginRequired && settings.notificationsEnabled && newlyFound.length) {
      await notifyNewAnnouncements(newlyFound);
    }

    return {
      ok: !loginRequired,
      status,
      source,
      newCount: newlyFound.length,
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
  await ensureOffscreenDocument();

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
      "Parse UIU eLMS course and forum HTML to detect announcement posts."
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

async function markAllAnnouncementsRead() {
  const { announcements = [] } =
    await chrome.storage.local.get("announcements");

  const now = Date.now();
  const updated = announcements.map((announcement) => ({
    ...announcement,
    isNew: false,
    readAt: announcement.readAt || now
  }));

  await chrome.storage.local.set({ announcements: updated });
  await updateActionBadge();
}

async function updateActionBadge() {
  const { announcements = [] } =
    await chrome.storage.local.get("announcements");

  const count = announcements.filter((announcement) => announcement.isNew).length;

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
    "lastChecked",
    "status",
    "lastError",
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
