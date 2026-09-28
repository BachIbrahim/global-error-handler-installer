# Global Error Handler Installer

Attaches listeners to browser `window` error/unhandledrejection events or Node `process` uncaughtException/unhandledRejection, routing every event to a single callback with a normalized shape.

## Usage

```js
import { installGlobalErrorHandler } from 'global-error-handler-installer';

const detach = installGlobalErrorHandler((event) => {
  // event.type: 'error' | 'unhandledrejection'
  // event.message: string
  // event.source: 'window' | 'process' | 'unknown'
  // event.error: Error | null
  // event.raw: the original platform event
  console.error(event.type, event.message);
});

// Later, to remove all listeners:
detach();
```

Pass `{ preventDefault: true }` as the second argument to call `preventDefault()` on browser events (suppresses the default console output). In Node, this option has no effect — we never call `process.exit`; that decision belongs to your callback.

## Why this exists

Application code that needs to log or report crashes ends up writing the same glue four times: one listener for `window.onerror`, one for `unhandledrejection`, one for Node's `uncaughtException`, one for Node's `unhandledRejection`. Each platform hands you a different shape. This library collapses those four paths into one callback with one event type.

The trade-off: the normalized event is lossy. The `raw` field is included for callers who need platform-specific detail, but the common fields (`message`, `error`) are best-effort. Cross-origin script errors in browsers arrive as `"Script error."` with no Error object — that is a browser security restriction, not a bug in this library, and `error` will be `null` in that case.

## Edge cases

- Promise rejections can be any value, not just `Error` objects. A rejected promise with a string or number reason will arrive with `error: null` and `message` set to the stringified reason.
- `detach()` is idempotent; calling it twice is safe.
- If neither `window.addEventListener` nor `process.on` exists, `installGlobalErrorHandler` installs nothing and returns a no-op detach. Check `detectEnvironment()` beforehand if you need to distinguish this case.

## Exports

- `installGlobalErrorHandler(callback, options?)` — installs listeners, returns a `detach()` function.
- `normalizeErrorEvent(rawEvent, type, environment)` — normalizes a single raw event without installing listeners. `type` is `'error'` or `'unhandledrejection'`; `environment` is `'browser'`, `'node'`, or `'unknown'`.
- `detectEnvironment()` — returns `'browser'`, `'node'`, or `'unknown'`.
