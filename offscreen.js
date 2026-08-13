chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  try {
    let data;

    switch (message.type) {
      case "PARSE_COURSE":
        data = parseCourse(message.html, message.baseUrl);
        break;

      case "PARSE_COURSE_LIST":
        data = parseCourseList(message.html, message.baseUrl);
        break;

      case "PARSE_FORUM":
        data = parseForum(message.html, message.baseUrl);
        break;

      case "PARSE_DISCUSSION":
        data = parseDiscussion(message.html, message.baseUrl);
        break;

      case "PARSE_ASSIGNMENTS":
        data = parseAssignments(message.html, message.baseUrl);
        break;

      default:
        throw new Error("Unknown parser request.");
    }

    sendResponse({ ok: true, data });
  } catch (error) {
    console.error("UIU eLMS offscreen parser error:", error);
    sendResponse({
      ok: false,
      error: error?.message || "Could not parse eLMS HTML."
    });
  }

  return true;
});

function createDocument(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(html || ""), "text/html");

  // Remove content that should never contribute to extracted text.
  doc.querySelectorAll("script, style, noscript, template").forEach((node) => {
    node.remove();
  });

  return doc;
}

function parseCourse(html, baseUrl) {
  const doc = createDocument(html);

  const activities = [...doc.querySelectorAll("[data-activityname]")];

  const announcementActivity = activities.find((element) => {
    const name = cleanText(element.getAttribute("data-activityname"));
    return /^announcements?$/i.test(name) || /announcement/i.test(name);
  });

  let link =
    announcementActivity?.querySelector('a[href*="/mod/forum/view.php"]') ||
    announcementActivity?.closest("li, .activity")?.querySelector(
      'a[href*="/mod/forum/view.php"]'
    );

  if (!link) {
    const candidates = [
      ...doc.querySelectorAll('a[href*="/mod/forum/view.php"]')
    ];

    link = candidates.find((anchor) => {
      const text = cleanText(anchor.textContent);
      return /^announcements?(\s+forum)?$/i.test(text) ||
        /^announcements?\b/i.test(text);
    });
  }

  return {
    announcementForumUrl: link
      ? absoluteUrl(link.getAttribute("href"), baseUrl)
      : null
  };
}

function parseCourseList(html, baseUrl) {
  const doc = createDocument(html);
  const courses = new Map();

  for (const link of doc.querySelectorAll('a[href*="/course/view.php?id="]')) {
    const url = absoluteUrl(link.getAttribute("href"), baseUrl);
    const id = urlParameter(url, "id");
    if (!id || !/^\d+$/.test(id) || id === "1") continue;

    const container = link.closest(
      '[data-region="course-content"], .course-info-container, ' +
      ".course-summaryitem, .coursebox, .card"
    );
    const name = cleanText(
      link.querySelector(".multiline, .coursename")?.textContent ||
      container?.querySelector(
        '.coursename, .multiline, [data-region="course-name"], h3, h4'
      )?.textContent ||
      link.getAttribute("aria-label") ||
      link.getAttribute("title") ||
      link.textContent
    );
    const candidate = {
      id,
      name: name || `Course ${id}`
    };
    const existing = courses.get(id);
    if (!existing || candidate.name.length > existing.name.length) {
      courses.set(id, candidate);
    }
  }

  return { courses: [...courses.values()] };
}

function parseForum(html, baseUrl) {
  const doc = createDocument(html);
  const anchors = [
    ...doc.querySelectorAll('a[href*="/mod/forum/discuss.php"]')
  ];

  const discussions = new Map();

  for (const anchor of anchors) {
    const url = absoluteUrl(anchor.getAttribute("href"), baseUrl);
    if (!url) continue;

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }

    const id = parsed.searchParams.get("d");
    if (!id || !/^\d+$/.test(id)) continue;

    // Remove a post anchor so all links for the same discussion deduplicate.
    parsed.hash = "";
    const canonicalUrl = parsed.toString();

    const container = anchor.closest(
      "tr.discussion, tr, article, .discussion, .forumpost, .forum-post-container"
    );

    const preferredTitleLink =
      container?.querySelector(
        '.topic a[href*="/mod/forum/discuss.php"], ' +
        'h3 a[href*="/mod/forum/discuss.php"], ' +
        'h4 a[href*="/mod/forum/discuss.php"], ' +
        '.discussionname a[href*="/mod/forum/discuss.php"]'
      ) || anchor;

    const title = meaningfulDiscussionTitle(
      cleanText(preferredTitleLink.textContent),
      cleanText(anchor.textContent)
    );

    const author = cleanText(
      container?.querySelector(
        '.author a[href*="/user/"], .author, [data-region="author"]'
      )?.textContent
    );

    const timeElement = container?.querySelector("time");
    const dateText = cleanText(
      timeElement?.getAttribute("datetime") ||
      timeElement?.textContent ||
      container?.querySelector(
        ".lastpost, .lastpostdate, [data-region='lastpost'], .discussion-list-item-col-lastpost"
      )?.textContent
    );

    const existing = discussions.get(id);

    const candidate = {
      id,
      url: canonicalUrl,
      title: title || "Announcement",
      author,
      dateText
    };

    if (!existing || qualityScore(candidate) > qualityScore(existing)) {
      discussions.set(id, candidate);
    }
  }

  return {
    discussions: [...discussions.values()]
  };
}

function parseDiscussion(html, baseUrl) {
  const doc = createDocument(html);

  const post =
    doc.querySelector(
      ".forumpost, article[data-region='post'], .forum-post-container, [data-content='forum-post']"
    ) ||
    doc.querySelector("main article") ||
    doc.querySelector("#region-main");

  const pageTitle = cleanTitle(doc.title);

  const postTitle = cleanText(
    post?.querySelector(
      ".subject, [data-region='post-subject'], h3, h4"
    )?.textContent
  );

  const title =
    meaningfulDiscussionTitle(postTitle, pageTitle) ||
    pageTitle ||
    "Announcement";

  const author = cleanText(
    post?.querySelector(
      '.author a[href*="/user/"], .author, [data-region="post-info"] a[href*="/user/"]'
    )?.textContent
  );

  const timeElement = post?.querySelector("time");
  const dateText = cleanText(
    timeElement?.getAttribute("datetime") ||
    timeElement?.textContent ||
    post?.querySelector(
      ".author .date, .post-date, [data-region='post-date']"
    )?.textContent
  );

  let contentNode =
    post?.querySelector(
      ".posting, .post-content-container, [data-region='post-content'], .text_to_html"
    ) ||
    post?.querySelector(".content");

  if (contentNode) {
    contentNode = contentNode.cloneNode(true);

    contentNode.querySelectorAll(
      "nav, form, button, .commands, .link, .attachments, .footer, .ratings, .post-actions"
    ).forEach((node) => node.remove());
  }

  let excerpt = cleanText(contentNode?.textContent);

  // Fallback: use the main post text while trying to avoid navigation chrome.
  if (!excerpt && post) {
    const clone = post.cloneNode(true);
    clone.querySelectorAll(
      "nav, form, button, .commands, .attachments, .footer, .ratings, .post-actions, .author, .subject"
    ).forEach((node) => node.remove());
    excerpt = cleanText(clone.textContent);
  }

  return {
    title,
    author,
    dateText,
    excerpt: excerpt.slice(0, 1200),
    url: baseUrl
  };
}

function parseAssignments(html, baseUrl) {
  const doc = createDocument(html);
  const candidates = new Set();

  doc.querySelectorAll(
    '[data-event-component="mod_assign"][data-event-eventtype="due"]'
  ).forEach((node) => candidates.add(node));

  doc.querySelectorAll('a[href*="/mod/assign/view.php"]').forEach((link) => {
    const container =
      link.closest('[data-region="event-item"], li, article, .event') || link;
    const eventType = cleanText(
      container.getAttribute?.("data-event-eventtype")
    );
    if (!eventType || eventType === "due") candidates.add(container);
  });

  doc.querySelectorAll('[data-event-component="mod_assign"]').forEach((node) => {
    const eventType = cleanText(node.getAttribute("data-event-eventtype"));
    if (!eventType || eventType === "due") candidates.add(node);
  });

  // The small Upcoming events block does not always include data-event-component.
  doc.querySelectorAll('[data-region="event-item"], .event').forEach((node) => {
    const hasAssignmentIcon = Boolean(
      node.querySelector('img[src*="/assign/"]')
    );
    const looksLikeDueEvent = /\bassignment\b.*\bdue\b/i.test(
      cleanText(node.textContent)
    );
    if (hasAssignmentIcon || looksLikeDueEvent) candidates.add(node);
  });

  const assignments = new Map();

  for (const container of candidates) {
    const directLink = container.matches('a[href*="/mod/assign/view.php"]')
      ? container
      : container.querySelector('a[href*="/mod/assign/view.php"]');
    const eventLink =
      container.querySelector('a[data-action="view-event"]') || directLink;
    const bestLink = directLink || eventLink;
    if (!bestLink) continue;

    const directUrl = directLink
      ? absoluteUrl(directLink.getAttribute("href"), baseUrl)
      : null;
    const eventUrl = eventLink
      ? absoluteUrl(eventLink.getAttribute("href"), baseUrl)
      : null;
    const assignmentId = urlParameter(directUrl, "id");
    const eventId =
      cleanId(eventLink?.getAttribute("data-event-id")) ||
      cleanId(container.getAttribute?.("data-event-id")) ||
      eventIdFromHash(eventUrl);

    const dueText = cleanText(
      container.querySelector("time")?.getAttribute("datetime") ||
      container.querySelector("time")?.textContent ||
      container.querySelector(
        ".date, .event-time, [data-region='event-time'], .calendar-event-time"
      )?.textContent
    );
    const dueAt = extractEventTimestamp(container, eventUrl, dueText);
    if (!dueAt) continue;

    const courseLink = container.querySelector(
      'a[href*="/course/view.php?id="]'
    );
    const courseUrl = courseLink
      ? absoluteUrl(courseLink.getAttribute("href"), baseUrl)
      : null;
    const courseId =
      urlParameter(courseUrl, "id") ||
      urlParameter(eventUrl, "course") ||
      nearestAttribute(container, "data-courseid");
    const courseName = cleanText(
      container.querySelector(
        ".course-name, .coursename, [data-region='course-name']"
      )?.textContent || courseLink?.textContent
    );
    const title = cleanText(
      container.querySelector(
        ".eventname, [data-region='event-name'], h3, h4, h5, h6"
      )?.textContent ||
      bestLink.getAttribute("title") ||
      bestLink.textContent
    );

    const key = assignmentId
      ? `assign:${assignmentId}`
      : eventId
        ? `event:${eventId}`
        : `${bestLink.getAttribute("href")}:${dueAt}`;
    const candidate = {
      assignmentId: cleanId(assignmentId),
      eventId: cleanId(eventId),
      courseId: cleanId(courseId),
      courseName,
      title,
      dueAt,
      dueText,
      url: directUrl || eventUrl
    };
    const existing = assignments.get(key);

    if (!existing || assignmentQuality(candidate) > assignmentQuality(existing)) {
      assignments.set(key, candidate);
    }
  }

  return {
    assignments: [...assignments.values()].sort(
      (a, b) => Number(a.dueAt) - Number(b.dueAt)
    )
  };
}

function extractEventTimestamp(container, eventUrl, dueText) {
  const timestampAttributes = [
    "data-timestamp",
    "data-day-timestamp",
    "data-time",
    "data-timestart",
    "data-due-date",
    "data-duedate"
  ];

  let current = container;
  while (current) {
    for (const attribute of timestampAttributes) {
      const parsed = normalizeTimestamp(current.getAttribute?.(attribute));
      if (parsed) return parsed;
    }
    current = current.parentElement;
  }

  const urlTimestamp = normalizeTimestamp(urlParameter(eventUrl, "time"));
  if (urlTimestamp) return urlTimestamp;

  for (const anchor of container.querySelectorAll('a[href*="time="]')) {
    const timestamp = normalizeTimestamp(
      urlParameter(absoluteUrl(anchor.getAttribute("href"), eventUrl), "time")
    );
    if (timestamp) return timestamp;
  }

  const parsedDate = Date.parse(dueText);
  return Number.isFinite(parsedDate) ? parsedDate : null;
}

function normalizeTimestamp(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed < 100000000000 ? parsed * 1000 : parsed;
}

function urlParameter(url, name) {
  if (!url) return null;
  try {
    return new URL(url).searchParams.get(name);
  } catch {
    return null;
  }
}

function eventIdFromHash(url) {
  if (!url) return null;
  try {
    return new URL(url).hash.match(/event_(\d+)/i)?.[1] || null;
  } catch {
    return null;
  }
}

function cleanId(value) {
  const text = String(value || "").trim();
  return /^\d+$/.test(text) ? text : null;
}

function nearestAttribute(node, name) {
  let current = node;
  while (current) {
    const value = current.getAttribute?.(name);
    if (value) return value;
    current = current.parentElement;
  }
  return null;
}

function assignmentQuality(item) {
  return (
    (item.assignmentId ? 30 : 0) +
    (item.url?.includes("/mod/assign/") ? 20 : 0) +
    (item.title?.length || 0) +
    (item.courseName?.length || 0) +
    (item.dueText?.length || 0)
  );
}

function meaningfulDiscussionTitle(...values) {
  const bad = /^(permalink|reply|replies|view|discussion|forum|\d+|last post)$/i;

  return values
    .map(cleanText)
    .filter(Boolean)
    .find((value) => !bad.test(value) && value.length > 2) || "";
}

function cleanTitle(value) {
  const text = cleanText(value);
  if (!text) return "";

  // Moodle page titles often look like:
  // "Discussion topic | Course name | UIU eLMS"
  return text
    .split("|")
    .map(cleanText)
    .filter(Boolean)[0] || text;
}

function qualityScore(item) {
  return (
    (item.title?.length || 0) * 2 +
    (item.author?.length || 0) +
    (item.dateText?.length || 0)
  );
}

function absoluteUrl(href, baseUrl) {
  if (!href) return null;

  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}
