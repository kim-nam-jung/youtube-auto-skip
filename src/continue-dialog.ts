// Self-contained: the worker serializes this function for a fixed CDP lookup.
// Match only YouTube's inactivity prompt, never a generic confirmation dialog.
export function findContinueTarget(): { x: number; y: number; href: string } | null {
  const url = new URL(location.href);
  if (url.origin !== "https://www.youtube.com" || url.pathname !== "/watch" || !url.searchParams.get("v")) return null;
  const video = document.querySelector<HTMLVideoElement>(".html5-video-player video");
  if (!video || video.paused !== true || video.ended === true) return null;
  const selector = 'ytd-confirm-dialog-renderer, yt-confirm-dialog-renderer, tp-yt-paper-dialog, [role="dialog"]';
  for (const dialog of document.querySelectorAll(selector)) {
    const text = (dialog.textContent || "").replace(/\s+/g, " ").trim();
    if (!/Video paused\.\s*Continue watching\?/i.test(text) &&
        !/(?:동영상|영상)이 일시\s*중지되었습니다\.\s*계속 시청(?:하시겠어요|할까요)\?/.test(text)) continue;
    for (const button of dialog.querySelectorAll('button, [role="button"], tp-yt-paper-button')) {
      const label = (button.textContent || "").replace(/\s+/g, " ").trim();
      if (!/^(?:확인|예|계속|계속 시청|Yes|Continue|OK)$/i.test(label) ||
          button.closest(selector) !== dialog ||
          !button.isConnected || button.matches(":disabled") ||
          button.closest('[hidden], [inert], [aria-disabled="true"], [aria-hidden="true"]')) continue;
      const style = getComputedStyle(button);
      if (style.visibility !== "visible" || style.pointerEvents === "none" || !button.getClientRects().length) continue;
      let hidden = false;
      for (let ancestor: Element | null = button; ancestor; ancestor = ancestor.parentElement) {
        const css = getComputedStyle(ancestor);
        if (css.display === "none" || css.contentVisibility === "hidden" || Number(css.opacity) === 0) hidden = true;
      }
      if (hidden) continue;
      const r = button.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight ||
          !hit || (hit !== button && !button.contains(hit))) continue;
      return { x, y, href: location.href };
    }
  }
  return null;
}
