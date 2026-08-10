chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  try {
    let data;

    switch (message.type) {
      case "PARSE_COURSE":
        data = parseCourse(message.html, message.baseUrl);
        break;

      case "PARSE_FORUM":
        data = parseForum(message.html, message.baseUrl);
        break;

      case "PARSE_DISCUSSION":
        data = parseDiscussion(message.html, message.baseUrl);
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
