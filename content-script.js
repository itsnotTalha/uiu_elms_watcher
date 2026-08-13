(() => {
  const ELMS_ORIGIN = "https://elms.uiu.ac.bd";
  let lastSignature = "";
  let timer = null;

  // Any authenticated eLMS page can be the post-login landing page. Let the
  // service worker discover courses directly instead of requiring My Courses.
  chrome.runtime.sendMessage({
    type: "ELMS_PAGE_ACTIVE",
    url: location.href
  }).catch(() => {});

  // Course-card observation is only a fallback for Moodle installations that
  // do not expose the enrolled-course AJAX method.
  if (location.pathname !== "/my/courses.php") return;

  function cleanText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/\u00a0/g, " ")
      .trim();
  }

  function getBestCourseName(link) {
    const explicit =
      link.querySelector(".multiline")?.textContent ||
      link.querySelector(".coursename")?.textContent ||
      link.getAttribute("aria-label") ||
      link.getAttribute("title") ||
      link.textContent;

    if (cleanText(explicit)) return cleanText(explicit);

    const card = link.closest(
      '[data-region="course-content"], .course-info-container, .card, .course-summaryitem'
    );

    if (card) {
      const candidate = card.querySelector(
        ".coursename, .multiline, [data-region='course-name'], h3, h4"
      );
      if (candidate) return cleanText(candidate.textContent);
    }

    return "";
  }

  function collectCourses() {
    const links = [
      ...document.querySelectorAll('a[href*="/course/view.php?id="]')
    ];

    const courseMap = new Map();

    for (const link of links) {
      try {
        const url = new URL(link.href, location.href);

        if (url.origin !== ELMS_ORIGIN) continue;
        if (url.pathname !== "/course/view.php") continue;

        const id = url.searchParams.get("id");

        if (!id || !/^\d+$/.test(id) || id === "1") continue;

        const name = getBestCourseName(link) || `Course ${id}`;
        const existing = courseMap.get(id);

        if (!existing || name.length > existing.name.length) {
          courseMap.set(id, {
            id,
            name,
            url: `${ELMS_ORIGIN}/course/view.php?id=${encodeURIComponent(id)}`
          });
        }
      } catch {
        // Ignore malformed/non-course links.
      }
    }

    return [...courseMap.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  async function publishCourses() {
    const courses = collectCourses();
    if (!courses.length) return;

    const signature = JSON.stringify(
      courses.map((course) => [course.id, course.name])
    );

    if (signature === lastSignature) return;
    lastSignature = signature;

    try {
      await chrome.runtime.sendMessage({
        type: "COURSES_DISCOVERED",
        courses
      });
    } catch (error) {
      console.debug("UIU eLMS Watcher could not publish courses:", error);
    }
  }

  function schedulePublish(delay = 250) {
    clearTimeout(timer);
    timer = setTimeout(publishCourses, delay);
  }

  // Moodle's My Overview block loads courses asynchronously, so check now
  // and continue watching DOM changes until the cards appear.
  schedulePublish(100);
  schedulePublish(1000);
  setTimeout(publishCourses, 3000);

  const observer = new MutationObserver(() => schedulePublish(350));
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
