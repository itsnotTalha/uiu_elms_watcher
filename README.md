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


## HOW to Install locally

1. Extract this folder somewhere permanent.
2. In Chrome, open `chrome://extensions/`. ![Step 1](step1.png)
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Download and extract the extension ZIP file. Select the `uiu-elms-announcement-watcher` folder.![Step 2](step2.png)
6. Sign in normally at UIU eLMS.
7. Open `https://elms.uiu.ac.bd/my/courses.php` once.
8. Wait until your course cards load.
9. Click the extension icon and press the refresh button if needed.


## First-Time Setup

1. Log in to your UIU eLMS account normally.
2. Open **My Courses** in eLMS.
3. Wait a few seconds for your courses to load.
4. Click the extension icon in Chrome.
5. Click the **Refresh** button once.

The extension will automatically detect your enrolled courses.

## How to Use

- Click the extension icon anytime to see your course announcements.
- New announcements will be marked as **NEW**.
- You will receive a Chrome notification when a new announcement is detected.
- Click an announcement to open it directly in eLMS.
- Use **Mark all read** to clear the NEW status.
- Use the search box to find announcements.
- You can change the checking interval from **Settings**.
- You can turn desktop notifications on or off from **Settings**.

## Important

- You must stay logged in to UIU eLMS for the extension to check announcements.
- The extension does not ask for or store your eLMS password.
- On the first scan, existing announcements are only saved. Notifications are shown only for announcements posted after that.

## Extension Preview

Add your extension UI screenshot here.

![UIU eLMS Announcement Watcher](screenshot.png)
