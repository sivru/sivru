import { useEffect, useLayoutEffect, useRef } from "react";

type Handlers = {
  onNext: () => void;
  onPrev: () => void;
  onEnter: () => void;
  onEscape: () => void;
  onQuickFilter: () => void;
  // Bindings only fire when this returns true.
  enabled: boolean;
};

// Returns true if the currently focused element is a text input we shouldn't
// hijack. We don't want J/K to advance the feed while the user is typing in
// the quick-filter box.
function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null) return false;
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * Keep a ref pointing at the latest version of `value`. The "latest ref"
 * pattern lets effect bodies read fresh state without listing volatile
 * closures in their deps array — the listener stays attached for the
 * component's lifetime, even as the closures change.
 */
function useLatest<T>(value: T): { current: T } {
  const ref = useRef(value);
  // useLayoutEffect (vs. useEffect) updates the ref synchronously after
  // render so a keypress dispatched inside the same paint sees the new
  // value. With useEffect, a key event delivered before the post-paint
  // commit could read stale state.
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

export function useKeyboardNav(handlers: Handlers): void {
  // Pre-fix: the useEffect listed all 6 handler functions in its deps,
  // so every App render (which creates fresh closures for each) tore
  // down + reattached the keydown listener. Cheap individually but it
  // showed up in profiling as O(renders) wasted work.
  //
  // Now: stash the handlers in a ref and read through it inside the
  // listener. The effect runs ONCE — listener attaches at mount,
  // detaches at unmount. App can pass unstable closures without
  // penalty.
  const latest = useLatest(handlers);

  useEffect(() => {
    function handle(e: KeyboardEvent): void {
      const h = latest.current;
      // Cmd/Ctrl+K should still work even with selection state.
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        h.onQuickFilter();
        return;
      }

      if (e.key === "Escape") {
        h.onEscape();
        return;
      }

      if (!h.enabled) return;
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case "j":
        case "J":
        case "ArrowDown":
          e.preventDefault();
          h.onNext();
          break;
        case "k":
        case "K":
        case "ArrowUp":
          e.preventDefault();
          h.onPrev();
          break;
        case "Enter":
          h.onEnter();
          break;
        default:
          break;
      }
    }

    document.addEventListener("keydown", handle);
    return () => {
      document.removeEventListener("keydown", handle);
    };
  }, [latest]);
}
