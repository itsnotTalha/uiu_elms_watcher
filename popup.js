const ELMS_ORIGIN = "https://elms.uiu.ac.bd";
const MY_COURSES_URL = `${ELMS_ORIGIN}/my/courses.php`;
const LOGIN_URL = `${ELMS_ORIGIN}/login/index.php`;

const elements = {
  refreshButton: document.querySelector("#refreshButton"),
  statusDot: document.querySelector("#statusDot"),
  statusText: document.querySelector("#statusText"),
  lastCheckedText: document.querySelector("#lastCheckedText"),
  newCount: document.querySelector("#newCount"),
  courseCount: document.querySelector("#courseCount"),
  announcementCount: document.querySelector("#announcementCount"),
  newTabCount: document.querySelector("#newTabCount"),
  noticeArea: document.querySelector("#noticeArea"),
  markAllReadButton: document.querySelector("#markAllReadButton"),
  searchInput: document.querySelector("#searchInput"),
  announcementList: document.querySelector("#announcementList"),
  announcementTemplate: document.querySelector("#announcementTemplate"),
  settingsToggle: document.querySelector("#settingsToggle"),
  settingsBody: document.querySelector("#settingsBody"),
  intervalSelect: document.querySelector("#intervalSelect"),
  notificationsToggle: document.querySelector("#notificationsToggle"),
  openCoursesButton: document.querySelector("#openCoursesButton"),
  tabs: [...document.querySelectorAll(".tab")]
};

let state = {
  settings: {
    intervalMinutes: 5,
    notificationsEnabled: true
  },
  courses: [],
  announcements: [],
  lastChecked: null,
  status: "loading",
  lastError: null,
  checking: false
};

let activeFilter = "all";
let searchQuery = "";

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  await loadState();

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
    renderAnnouncements();
  });

  for (const tab of elements.tabs) {
    tab.addEventListener("click", () => {
      activeFilter = tab.dataset.filter;

      elements.tabs.forEach((item) =>
        item.classList.toggle("active", item === tab)
      );

      renderAnnouncements();
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

  elements.openCoursesButton.addEventListener("click", () => {
    chrome.tabs.create({ url: MY_COURSES_URL });
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
      announcements: response.announcements || []
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
  renderAnnouncements();
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
    elements.statusText.textContent = "Setup needed";
  } else {
    elements.statusDot.classList.add("error");
    elements.statusText.textContent = "Check failed";
  }

  elements.lastCheckedText.textContent = state.lastChecked
    ? `Checked ${formatRelativeTime(state.lastChecked)}`
    : "Not checked yet";
}

function renderSummary() {
  const newCount = state.announcements.filter((item) => item.isNew).length;

  elements.newCount.textContent = String(newCount);
  elements.courseCount.textContent = String(state.courses.length);
  elements.announcementCount.textContent = String(state.announcements.length);
  elements.newTabCount.textContent = String(newCount);

  elements.markAllReadButton.disabled = newCount === 0;
}

function renderNotice() {
  const area = elements.noticeArea;
  area.innerHTML = "";
  area.classList.add("hidden");

  if (state.status === "setup_required" || !state.courses.length) {
    showNotice({
      type: "warn",
      icon: "1",
      title: "Discover your courses",
      text:
        "Open My Courses once. The extension will automatically learn the courses enrolled in this eLMS account.",
      buttonText: "Open My Courses",
      onClick: () => chrome.tabs.create({ url: MY_COURSES_URL })
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

function renderAnnouncements() {
  const list = elements.announcementList;
  list.innerHTML = "";

  let announcements = [...state.announcements];

  announcements.sort((a, b) => {
    const aTime = Number(a.postedAt || a.firstSeenAt || 0);
    const bTime = Number(b.postedAt || b.firstSeenAt || 0);
    return bTime - aTime;
  });

  if (activeFilter === "new") {
    announcements = announcements.filter((item) => item.isNew);
  }

  if (searchQuery) {
    announcements = announcements.filter((item) => {
      const haystack = [
        item.title,
        item.courseName,
        item.author,
        item.excerpt
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(searchQuery);
    });
  }

  if (!announcements.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";

    const icon = document.createElement("div");
    icon.className = "empty-icon";
    icon.textContent = activeFilter === "new" ? "✓" : "◌";

    const title = document.createElement("h3");
    title.textContent =
      activeFilter === "new"
        ? "You're all caught up"
        : state.courses.length
          ? "No announcements saved yet"
          : "Courses have not been discovered";

    const text = document.createElement("p");
    text.textContent =
      activeFilter === "new"
        ? "New eLMS announcements will appear here and can also trigger a desktop notification."
        : state.courses.length
          ? "Press the refresh button to check your courses."
          : "Open your eLMS My Courses page once to start.";

    empty.append(icon, title, text);
    list.append(empty);
    return;
  }

  for (const announcement of announcements) {
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
}

function renderSettings() {
  elements.intervalSelect.value = String(
    state.settings?.intervalMinutes || 5
  );

  elements.notificationsToggle.checked =
    state.settings?.notificationsEnabled !== false;
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
