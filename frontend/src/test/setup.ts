import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach, vi } from "vitest"

// JSDOM does not implement element scrolling. Components still schedule
// scrolls after rendering, so provide the browser API for those effects.
Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  writable: true,
  value: vi.fn(),
})

afterEach(() => cleanup())
