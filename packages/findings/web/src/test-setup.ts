import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/**
 * jsdom has no ResizeObserver, and the components that use one use it to
 * measure a layout jsdom does not do either: every offsetWidth here is zero.
 *
 * So this is a stub rather than a polyfill. It exists so that mounting a
 * component does not throw; anything that depends on a real measurement is
 * checked in a browser instead, and the tests say so where that applies.
 */
class NoResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= NoResizeObserver;

/**
 * jsdom does not scroll, so it has no scrollIntoView. The queue calls it to
 * keep a row chosen by the keyboard on screen, which is a thing to check in a
 * browser rather than here — but it must not throw on the way past.
 */
// Defined rather than assigned, because reading a method off a prototype to
// test it is the thing the unbound-method rule exists to catch.
Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  writable: true,
  value: function scrollIntoView(this: void): void {},
});

/**
 * jsdom has no matchMedia, and the diagram asks for one to hear about the
 * machine changing between light and dark. A stub that never fires is the
 * honest one here: nothing in a test changes the system theme, and the way
 * this page is actually told — the attribute on the document — is observed
 * separately and does work in jsdom.
 */
// Defined rather than assigned, for the same reason as the one above: `??=`
// reads the method off the object first, which is the thing the unbound-method
// rule is watching for.
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value: function matchMedia(this: void, query: string) {
    return {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  },
});

afterEach(() => {
  cleanup();
});

/**
 * jsdom has no Notification, and the point of the test that names it is that
 * nothing asks for permission on its own. A stub that records the ask is the
 * only way to check that it was never made.
 */
globalThis.Notification ??= Object.assign(vi.fn(), {
  permission: "default",
  requestPermission: vi.fn(),
}) as unknown as typeof Notification;
