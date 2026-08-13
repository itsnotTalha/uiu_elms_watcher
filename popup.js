const ELMS_ORIGIN = "https://elms.uiu.ac.bd";
const DASHBOARD_URL = `${ELMS_ORIGIN}/my/`;
const LOGIN_URL = `${ELMS_ORIGIN}/login/index.php`;

const elements = {
  refreshButton: document.querySelector("#refreshButton"),
  statusDot: document.querySelector("#statusDot"),
  statusText: document.querySelector("#statusText"),
  lastCheckedText: document.querySelector("#lastCheckedText"),
  newCount: document.querySelector("#newCount"),
  courseCount: document.querySelector("#courseCount"),
  assignmentCount: document.querySelector("#assignmentCount"),
  newTabCount: document.querySelector("#newTabCount"),
  assignmentTabCount: document.querySelector("#assignmentTabCount"),
  noticeArea: document.querySelector("#noticeArea"),
  markAllReadButton: document.querySelector("#markAllReadButton"),
  searchInput: document.querySelector("#searchInput"),
  announcementList: document.querySelector("#announcementList"),
  announcementTemplate: document.querySelector("#announcementTemplate"),
  assignmentTemplate: document.querySelector("#assignmentTemplate"),
  settingsToggle: document.querySelector("#settingsToggle"),
  settingsBody: document.querySelector("#settingsBody"),
  intervalSelect: document.querySelector("#intervalSelect"),
  notificationsToggle: document.querySelector("#notificationsToggle"),
  reminderMinutesInput: document.querySelector("#reminderMinutesInput"),
  openCoursesButton: document.querySelector("#openCoursesButton"),
  tabs: [...document.querySelectorAll(".tab")]
};

let state = {
  settings: {
    intervalMinutes: 5,
    notificationsEnabled: true,
    assignmentReminderMinutes: 60
  },
  courses: [],
  announcements: [],
  assignments: [],
  lastChecked: null,
  status: "loading",
  lastError: null,
  lastAssignmentError: null,
  checking: false
};

let activeFilter = "all";
let searchQuery = "";

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  await loadState();
  setInterval(updateCountdowns, 1000);

  // Keep UI synchronized if a background check finishes while popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    for (const [key, change] of Object.entries(changes)) {
      if (key in state) {
        state[key] = change.newValue;
      }
    }

    render();
  });
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", checkNow);

  elements.markAllReadButton.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "MARK_ALL_READ" });
    await loadState();
  });

  elements.searchInput.addEventListener("input", (event) => {
    searchQuery = event.target.value.trim().toLowerCase();
    renderItems();
  });

  for (const tab of elements.tabs) {
    tab.addEventListener("click", () => {
      activeFilter = tab.dataset.filter;

      elements.tabs.forEach((item) =>
        item.classList.toggle("active", item === tab)
      );

      renderItems();
    });
  }

  elements.settingsToggle.addEventListener("click", () => {
    const expanded =
      elements.settingsToggle.getAttribute("aria-expanded") === "true";

    elements.settingsToggle.setAttribute(
      "aria-expanded",
      String(!expanded)
    );

    elements.settingsBody.classList.toggle("hidden", expanded);
  });

  elements.intervalSelect.addEventListener("change", async () => {
    await saveSettings({
      intervalMinutes: Number(elements.intervalSelect.value)
    });
  });

  elements.notificationsToggle.addEventListener("change", async () => {
    await saveSettings({
      notificationsEnabled: elements.notificationsToggle.checked
    });
  });

  elements.reminderMinutesInput.addEventListener("change", async () => {
    await saveSettings({
      assignmentReminderMinutes: Number(elements.reminderMinutesInput.value)
    });
  });

  elements.openCoursesButton.addEventListener("click", () => {
    chrome.tabs.create({ url: DASHBOARD_URL });
  });
}

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });

  if (response?.ok) {
    state = {
      ...state,
      ...response,
      settings: {
        ...state.settings,
        ...(response.settings || {})
      },
      courses: response.courses || [],
      announcements: response.announcements || [],
      assignments: response.assignments || []
    };
  }

  render();
}

async function checkNow() {
  if (state.checking) return;

  elements.refreshButton.classList.add("loading");
  elements.refreshButton.disabled = true;

  try {
    await chrome.runtime.sendMessage({ type: "CHECK_NOW" });
    await loadState();
  } finally {
    elements.refreshButton.classList.remove("loading");
    elements.refreshButton.disabled = false;
  }
}

async function saveSettings(partial) {
  const response = await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings: partial
  });

  if (response?.ok) {
    state.settings = response.settings;
    renderSettings();
  }
}

function render() {
  renderStatus();
  renderSummary();
  renderNotice();
  renderItems();
  renderSettings();

  elements.refreshButton.classList.toggle("loading", Boolean(state.checking));
  elements.refreshButton.disabled = Boolean(state.checking);
}

function renderStatus() {
  elements.statusDot.className = "status-dot";

  const status = state.status || "setup_required";

  if (state.checking) {
    elements.statusDot.classList.add("warn");
    elements.statusText.textContent = "Checking eLMS…";
  } else if (status === "ready") {
    elements.statusDot.classList.add("ready");
    elements.statusText.textContent = "Connected";
  } else if (status === "login_required") {
    elements.statusDot.classList.add("warn");
    elements.statusText.textContent = "Login required";
  } else if (status === "setup_required") {
    elements.statusDot.classList.add("warn");
    elements.statusText.textContent = "Waiting for eLMS";
  } else {
    elements.statusDot.classList.add("error");
    elements.statusText.textContent = "Check failed";
  }

  elements.lastCheckedText.textContent = state.lastChecked
    ? `Checked ${formatRelativeTime(state.lastChecked)}`
    : "Not checked yet";
}

function renderSummary() {
  const newCount =
    state.announcements.filter((item) => item.isNew).length +
    state.assignments.filter((item) => item.isNew).length;
  const upcomingCount = state.assignments.filter(
    (item) => Number(item.dueAt) > Date.now()
  ).length;

  elements.newCount.textContent = String(newCount);
  elements.courseCount.textContent = String(state.courses.length);
  elements.assignmentCount.textContent = String(upcomingCount);
  elements.newTabCount.textContent = String(newCount);
  elements.assignmentTabCount.textContent = String(upcomingCount);

  elements.markAllReadButton.disabled = newCount === 0;
}

function renderNotice() {
  const area = elements.noticeArea;
  area.innerHTML = "";
  area.classList.add("hidden");

  if (state.status === "setup_required") {
    showNotice({
      type: "warn",
      icon: "1",
      title: "Sign in to eLMS",
      text:
        "Sign in normally and open any eLMS page. Courses, assignments and announcements will be discovered automatically.",
      buttonText: "Open eLMS",
      onClick: () => chrome.tabs.create({ url: DASHBOARD_URL })
    });
    return;
  }

  if (state.status === "login_required") {
    showNotice({
      type: "warn",
      icon: "!",
      title: "Sign in to UIU eLMS",
      text:
        "Your eLMS session is not active. Sign in normally; the extension never asks for or stores your password.",
      buttonText: "Open login",
      onClick: () => chrome.tabs.create({ url: LOGIN_URL })
    });
    return;
  }

  if (state.status === "error") {
    showNotice({
      type: "error",
      icon: "!",
      title: "Could not complete the last check",
      text: state.lastError || "Try Check now again.",
      buttonText: "Check now",
      onClick: checkNow
    });
    return;
  }

  if (state.lastAssignmentError) {
    showNotice({
      type: "warn",
      icon: "!",
      title: "Assignments could not be refreshed",
      text: state.lastAssignmentError,
      buttonText: "Try again",
      onClick: checkNow
    });
  }
}

function showNotice({ type, icon, title, text, buttonText, onClick }) {
  const area = elements.noticeArea;
  area.classList.remove("hidden");

  const notice = document.createElement("div");
  notice.className = `notice ${type || ""}`;

  const iconEl = document.createElement("div");
  iconEl.className = "notice-icon";
  iconEl.textContent = icon;

  const body = document.createElement("div");
  body.className = "notice-body";

  const strong = document.createElement("strong");
  strong.textContent = title;

  const p = document.createElement("p");
  p.textContent = text;

  body.append(strong, p);

  if (buttonText && onClick) {
    const button = document.createElement("button");
    button.className = "notice-action";
    button.type = "button";
    button.textContent = buttonText;
    button.addEventListener("click", onClick);
    body.append(button);
  }

  notice.append(iconEl, body);
  area.append(notice);
}

function renderItems() {
  const list = elements.announcementList;
  list.innerHTML = "";

  const now = Date.now();
  let items = [
    ...[...state.assignments]
      .filter((item) => Number(item.dueAt) > now)
      .sort((a, b) => Number(a.dueAt) - Number(b.dueAt))
      .map((item) => ({ type: "assignment", value: item })),
    ...[...state.announcements]
      .sort((a, b) => {
        const aTime = Number(a.postedAt || a.firstSeenAt || 0);
        const bTime = Number(b.postedAt || b.firstSeenAt || 0);
        return bTime - aTime;
      })
      .map((item) => ({ type: "announcement", value: item }))
  ];

  if (activeFilter === "new") {
    items = items.filter((item) => item.value.isNew);
  } else if (activeFilter === "assignments") {
    items = items.filter((item) => item.type === "assignment");
  }

  if (searchQuery) {
    items = items.filter((item) => {
      const haystack = [
        item.value.title,
        item.value.courseName,
        item.value.author,
        item.value.excerpt,
        item.type
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(searchQuery);
    });
  }

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";

    const icon = document.createElement("div");
    icon.className = "empty-icon";
    icon.textContent = activeFilter === "new" ? "✓" : "◌";

    const title = document.createElement("h3");
    title.textContent =
      activeFilter === "new"
        ? "You're all caught up"
        : activeFilter === "assignments"
          ? "No upcoming assignments"
        : state.courses.length
          ? "Nothing saved yet"
          : state.status === "ready"
            ? "No enrolled courses found"
            : "Courses have not been discovered";

    const text = document.createElement("p");
    text.textContent =
      activeFilter === "new"
        ? "New announcements and assignments will appear here and can trigger a desktop notification."
        : activeFilter === "assignments"
          ? "Upcoming assignment deadlines will appear here with a live countdown."
        : state.courses.length
          ? "Press the refresh button to check eLMS."
          : state.status === "ready"
            ? "The watcher will automatically retry on the next scheduled check."
            : "Sign in and open any eLMS page to start automatic discovery.";

    empty.append(icon, title, text);
    list.append(empty);
    return;
  }

  for (const item of items) {
    if (item.type === "assignment") {
      renderAssignment(list, item.value);
    } else {
      renderAnnouncement(list, item.value);
    }
  }

  updateCountdowns();
}

function renderAnnouncement(list, announcement) {
    const fragment = elements.announcementTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".announcement-card");
    const button = fragment.querySelector(".announcement-open");

    card.classList.toggle("is-new", Boolean(announcement.isNew));

    fragment.querySelector(".course-chip").textContent =
      announcement.courseName || "UIU Course";

    fragment.querySelector(".announcement-title").textContent =
      announcement.title || "Announcement";

    fragment.querySelector(".announcement-excerpt").textContent =
      announcement.excerpt || "";

    const author = fragment.querySelector(".announcement-author");
    author.textContent = announcement.author || "eLMS";
    author.title = announcement.author || "";

    fragment.querySelector(".announcement-date").textContent =
      formatAnnouncementDate(announcement);

    button.addEventListener("click", async () => {
      if (announcement.isNew) {
        await chrome.runtime.sendMessage({
          type: "MARK_READ",
          key: announcement.key
        });
      }

      if (announcement.url) {
        chrome.tabs.create({ url: announcement.url });
      }

      window.close();
    });

    list.append(fragment);
}

function renderAssignment(list, assignment) {
  const fragment = elements.assignmentTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".assignment-card");
  const button = fragment.querySelector(".assignment-open");
  const dueAt = Number(assignment.dueAt);

  card.classList.toggle("is-new", Boolean(assignment.isNew));
  fragment.querySelector(".course-chip").textContent =
    assignment.courseName || "UIU eLMS";
  fragment.querySelector(".assignment-title").textContent =
    assignment.title || "Assignment";

  const countdown = fragment.querySelector(".assignment-countdown");
  countdown.dataset.dueAt = String(dueAt);
  fragment.querySelector(".assignment-due-date").textContent =
    formatAssignmentDueDate(dueAt);
  fragment.querySelector(".reminder-label").textContent =
    `Reminder ${formatReminderLead(state.settings.assignmentReminderMinutes)} before`;

  button.addEventListener("click", async () => {
    if (assignment.isNew) {
      await chrome.runtime.sendMessage({
        type: "MARK_ASSIGNMENT_READ",
        key: assignment.key
      });
    }

    if (assignment.url) chrome.tabs.create({ url: assignment.url });
    window.close();
  });

  list.append(fragment);
}

function renderSettings() {
  elements.intervalSelect.value = String(
    state.settings?.intervalMinutes || 5
  );

  elements.notificationsToggle.checked =
    state.settings?.notificationsEnabled !== false;

  elements.reminderMinutesInput.value = String(
    state.settings?.assignmentReminderMinutes || 60
  );
  elements.reminderMinutesInput.disabled =
    state.settings?.notificationsEnabled === false;
}

function updateCountdowns() {
  const now = Date.now();

  document.querySelectorAll(".assignment-countdown[data-due-at]").forEach(
    (element) => {
      const remaining = Number(element.dataset.dueAt) - now;
      element.textContent = formatCountdown(remaining);
      element.classList.toggle("urgent", remaining > 0 && remaining <= 3600000);
      element.classList.toggle(
        "soon",
        remaining > 3600000 && remaining <= 86400000
      );
      element.classList.toggle("overdue", remaining <= 0);
    }
  );
}

function formatCountdown(remainingMs) {
  if (!Number.isFinite(remainingMs)) return "Due time unavailable";
  if (remainingMs <= 0) return "Due now";

  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");

  return days ? `${days}d ${clock} remaining` : `${clock} remaining`;
}

function formatAssignmentDueDate(timestamp) {
  const value = Number(timestamp);
  if (!value) return "Due date unavailable";

  return `Due ${new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value))}`;
}

function formatReminderLead(value) {
  const minutes = Number(value) || 60;
  if (minutes < 60) return `${minutes}m`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatAnnouncementDate(announcement) {
  if (announcement.postedAt) {
    return formatRelativeTime(announcement.postedAt);
  }

  if (announcement.dateText) {
    const cleaned = String(announcement.dateText)
      .replace(/\s+/g, " ")
      .trim();

    if (cleaned.length <= 42) return cleaned;
  }

  if (announcement.firstSeenAt) {
    return `Seen ${formatRelativeTime(announcement.firstSeenAt)}`;
  }

  return "Date unavailable";
}

function formatRelativeTime(timestamp) {
  const value = Number(timestamp);
  if (!value) return "recently";

  const delta = Date.now() - value;
  const abs = Math.abs(delta);

  const minutes = Math.floor(abs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}
