# UIU eLMS Announcement Watcher

A Chrome Manifest V3 extension for UIU eLMS that:

- discovers the courses in the currently logged-in student's **My Courses** page;
- finds the **Announcements** activity inside each course;
- checks the Moodle announcement forum on a schedule;
- stores recent announcements locally in the browser;
- shows announcement titles and available announcement text in a modern popup;
- marks newly discovered posts as **NEW**;
- shows a badge with the unread-new count;
- sends Chrome desktop notifications for newly discovered announcements;
- opens the exact announcement when clicked;
- never asks for or stores the student's eLMS password.

## Important first-run behavior

The first successful scan of each course is treated as a **baseline**. Existing
old announcements are saved for display, but they do **not** trigger desktop
notifications. Only announcements discovered after that baseline are marked NEW
and notified.

## Install locally

1. Extract this folder somewhere permanent.
2. In Chrome, open `chrome://extensions/`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the `uiu-elms-announcement-watcher` folder.
6. Sign in normally at UIU eLMS.
7. Open `https://elms.uiu.ac.bd/my/courses.php` once.
8. Wait until your course cards load.
9. Click the extension icon and press the refresh button if needed.

## Why "Open My Courses once" is required

The provided UIU eLMS source shows Moodle's My Overview block, where student
course cards are populated dynamically by JavaScript. A content script watches
that rendered page and learns the course IDs for the currently logged-in
student. No course ID is hard-coded.

## Files

- `manifest.json` — Chrome extension manifest.
- `background.js` — scheduling, fetching, state, new-announcement detection,
  desktop notifications, badge updates.
- `content-script.js` — discovers dynamically rendered course links.
- `offscreen.html` / `offscreen.js` — DOM parsing for course, forum, and
  discussion HTML.
- `popup.html` / `popup.css` / `popup.js` — modern popup UI.
- `icons/` — extension icons.

## Parser notes

The course-page parser is based on the HTML sample supplied for UIU eLMS. It
looks for a Moodle activity whose `data-activityname` contains "Announcements"
and then extracts its `/mod/forum/view.php?...` URL.

The actual Announcements forum page source was not supplied. The forum parser is
therefore intentionally robust and searches standard Moodle discussion URLs:

`/mod/forum/discuss.php?d=<discussion-id>`

It also has fallback selectors for common Moodle forum markup.

If UIU has customized the forum HTML enough that titles/content do not appear
correctly, provide the HTML source of one page reached by clicking
**Announcements**. Usually only `parseForum()` / `parseDiscussion()` in
`offscreen.js` would need a small selector adjustment.

## Privacy / security

- Host access is limited to `https://elms.uiu.ac.bd/*`.
- Data is stored in `chrome.storage.local`.
- No analytics, external server, CDN, or remote JavaScript is used.
- The extension uses the active browser/eLMS login session; it does not collect
  login credentials.
- Do not hard-code copied Moodle `sesskey` values. They are session-specific.

## Change the check interval

Open the extension popup → **Settings** → **Check interval**.

Available values: 1, 2, 5, 10, 15, 30, or 60 minutes.

## Development/testing

After changing source code:

1. Open `chrome://extensions/`.
2. Click the **Reload** button on the extension card.
3. Reload the UIU My Courses page if testing course discovery.
4. Use the popup refresh button to force a check.

For service-worker logs:

1. Open `chrome://extensions/`.
2. Find UIU eLMS Announcement Watcher.
3. Click **Service worker** / **Inspect views**.

For content-script logs, open DevTools on the My Courses page.
