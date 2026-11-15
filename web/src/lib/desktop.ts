export const isPersonalDesktop = process.env.NEXT_PUBLIC_PERSONAL_DESKTOP === "1";

// Desktop requests go through the local gateway so provider CORS rules do not block personal API channels.
export function initializeDesktopFetch() {
    if (!isPersonalDesktop || typeof window === "undefined") return;
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
        if (!["http:", "https:"].includes(url.protocol) || url.origin === window.location.origin) return original(input, init);
        const request = new Request(input instanceof Request ? input : url, init);
        return original(new Request("/desktop/request?url=" + encodeURIComponent(url.href), request), { credentials: "omit", mode: "same-origin" });
    };
}
