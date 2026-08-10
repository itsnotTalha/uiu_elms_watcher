function collectCourses() {
    const container = document.querySelector(
        '[data-region="course-view-content"]'
    );

    if (!container) return;

    const links = container.querySelectorAll(
        'a[href*="/course/view.php?id="]'
    );

    const courses = new Map();

    links.forEach(link => {
        try {
            const url = new URL(link.href);

            const id = url.searchParams.get("id");

            if (!id) return;

            courses.set(id, {
                id,
                url: `https://elms.uiu.ac.bd/course/view.php?id=${id}`,
                name: link.textContent.trim()
            });

        } catch (error) {
            console.error(error);
        }
    });

    if (courses.size > 0) {
        chrome.storage.local.set({
            courses: [...courses.values()]
        });

        console.log(
            "eLMS Watcher found courses:",
            [...courses.values()]
        );
    }
}

collectCourses();

const observer = new MutationObserver(() => {
    collectCourses();
});

observer.observe(document.body, {
    childList: true,
    subtree: true
});
