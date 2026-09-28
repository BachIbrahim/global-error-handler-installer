/**
 * Core implementation of the global error handler installer.
 *
 * Design decisions:
 *
 * 1. Single callback, normalized event. Every listener (browser `error`,
 *    browser `unhandledrejection`, Node `uncaughtException`, Node
 *    `unhandledRejection`) routes to the same user callback with a uniform
 *    shape. This lets application code treat all crash paths identically.
 *
 * 2. The installer returns a `detach()` function. Removing listeners by
 *    reference is the only reliable cross-engine approach; `removeAllListeners`
 *    would clobber listeners the caller never asked us to touch.
 *
 * 3. We do NOT swallow or rethrow. Preventing default is the caller's
 *    decision — some teams want the browser console to still log, others want
 *    to suppress. We call `preventDefault()` only when the caller opts in via
 *    `options.preventDefault`.
 *
 * 4. Environment detection is done once at install time, not per event, so a
 *    misconfigured global (e.g. `window` defined in a Node test shim) does not
 *    cause us to attach to the wrong target after the fact.
 */

/**
 * @typedef {Object} NormalizedErrorEvent
 * @property {'error'|'unhandledrejection'} type
 *   `error` for synchronous exceptions; `unhandledrejection` for promises.
 * @property {string} message
 *   Best-effort human-readable message. Falls back to the event type name if
 *   no message can be extracted.
 * @property {string} source
 *   Where the error originated: `'window'`, `'process'`, or `'unknown'`.
 * @property {Error|null} error
 *   The original Error object when available. `null` when the platform only
 *   gives us a message string (e.g. cross-origin script errors in browsers).
 * @property {unknown} raw
 *   The untouched platform event for callers who need platform-specific detail.
 */

/**
 * @typedef {Object} InstallOptions
 * @property {boolean} [preventDefault=false]
 *   If true, call `preventDefault()` on browser events and
 *   `process.exit` is NOT called — we never force-exit; that is the caller's
 *   job via the callback.
 */

/**
 * Detects whether we are in a browser-like or Node-like environment.
 *
 * We check `process` before `window` because some bundlers expose a shimmed
 * `window` in Node; the presence of `process.on` is a stronger signal for the
 * Node path.
 *
 * @returns {'browser'|'node'|'unknown'}
 */
export function detectEnvironment() {
  // Use typeof guards so this function never throws in an environment that
  // does not define `process` or `window` at all (e.g. some sandboxes).
  if (typeof process !== 'undefined' && process && typeof process.on === 'function' && typeof process.removeListener === 'function') {
    return 'node';
  }
  if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function' && typeof window.removeEventListener === 'function') {
    return 'browser';
  }
  return 'unknown';
}

/**
 * Extracts a string message from any value an error event might carry.
 *
 * Browsers send cross-origin script errors as the literal string "Script error."
 * with no Error object. Node sends actual Error instances. Promise rejections
 * can be literally anything (a string, a number, null). We normalize all of
 * these to a non-empty string.
 *
 * @param {unknown} value
 * @returns {string}
 */
function extractMessage(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  // Objects with a `.message` property (DOMException, custom errors). We do
  // not stringify arbitrary objects because `toString()` on plain objects
  // yields "[object Object]" which is useless; better to return empty and let
  // the caller fall back to the type name.
  if (typeof value === 'object' && typeof value.message === 'string') {
    return value.message;
  }
  // Primitives: convert to string only if meaningful.
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  // Symbols and functions have no useful message representation.
  if (typeof value === 'symbol') {
    return value.toString();
  }
  return '';
}

/**
 * Normalizes a raw platform error event into a uniform shape.
 *
 * This is exported so callers can test the normalization logic in isolation
 * without installing global listeners.
 *
 * @param {unknown} rawEvent
 * @param {'error'|'unhandledrejection'} type
 * @param {'browser'|'node'|'unknown'} environment
 * @returns {NormalizedErrorEvent}
 */
export function normalizeErrorEvent(rawEvent, type, environment) {
  let error = null;
  let message = '';

  if (type === 'error') {
    // Browser `error` event: an ErrorEvent with .error and .message, OR a
    // plain Event when the error is cross-origin (error === null).
    if (environment === 'browser' && rawEvent && typeof rawEvent === 'object') {
      if (rawEvent.error instanceof Error) {
        error = rawEvent.error;
      }
      message = typeof rawEvent.message === 'string' ? rawEvent.message : '';
      // If the event has no message but carries an error, use the error's message.
      if (!message && error) {
        message = error.message;
      }
    } else {
      // Node `uncaughtException`: the raw event is the Error itself.
      if (rawEvent instanceof Error) {
        error = rawEvent;
        message = rawEvent.message;
      } else {
        message = extractMessage(rawEvent);
      }
    }
  } else {
    // unhandledrejection
    // Browser: PromiseRejectionEvent with `.reason`.
    // Node: the reason is passed as the first argument.
    let reason;
    if (environment === 'browser' && rawEvent && typeof rawEvent === 'object' && 'reason' in rawEvent) {
      reason = rawEvent.reason;
    } else {
      reason = rawEvent;
    }
    if (reason instanceof Error) {
      error = reason;
      message = reason.message;
    } else {
      message = extractMessage(reason);
    }
  }

  if (!message) {
    // Last resort: a non-empty string so downstream consumers never get ''.
    message = type === 'error' ? 'Unhandled error' : 'Unhandled promise rejection';
  }

  const source = environment === 'browser' ? 'window' : environment === 'node' ? 'process' : 'unknown';

  return { type, message, source, error, raw: rawEvent };
}

/**
 * Installs global error and unhandled-rejection listeners and routes every
 * event to a single callback with a normalized shape.
 *
 * @param {(event: NormalizedErrorEvent) => void} callback
 *   Called for every uncaught error or unhandled rejection. Synchronous-only;
 *   if you need async work, queue it inside the callback.
 * @param {InstallOptions} [options]
 * @returns {() => void} A `detach()` function that removes all listeners this
 *   call installed. Safe to call multiple times; subsequent calls are no-ops.
 */
export function installGlobalErrorHandler(callback, options) {
  if (typeof callback !== 'function') {
    throw new TypeError('installGlobalErrorHandler: callback must be a function');
  }
  const opts = options || {};
  const preventDefault = opts.preventDefault === true;
  const environment = detectEnvironment();

  // We close over `detached` so that a double-detach is harmless. This matters
  // because some test frameworks call cleanup hooks more than once.
  let detached = false;

  /** @type {Array<() => void>} */
  const cleanupFns = [];

  if (environment === 'browser') {
    /** @param {Event} ev */
    const onError = (ev) => {
      if (preventDefault && typeof ev.preventDefault === 'function') {
        ev.preventDefault();
      }
      callback(normalizeErrorEvent(ev, 'error', 'browser'));
    };
    /** @param {Event} ev */
    const onRejection = (ev) => {
      if (preventDefault && typeof ev.preventDefault === 'function') {
        ev.preventDefault();
      }
      callback(normalizeErrorEvent(ev, 'unhandledrejection', 'browser'));
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    cleanupFns.push(() => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    });
  } else if (environment === 'node') {
    /** @param {Error} err */
    const onUncaught = (err) => {
      callback(normalizeErrorEvent(err, 'error', 'node'));
    };
    /** @param {unknown} reason */
    const onRejection = (reason) => {
      callback(normalizeErrorEvent(reason, 'unhandledrejection', 'node'));
    };
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onRejection);
    cleanupFns.push(() => {
      process.removeListener('uncaughtException', onUncaught);
      process.removeListener('unhandledRejection', onRejection);
    });
  } else {
    // In an unknown environment we install nothing and detach is a no-op.
    // Throwing would break callers who defensively wrap installation; instead
    // they can check the return value or the environment via detectEnvironment().
  }

  return function detach() {
    if (detached) return;
    detached = true;
    for (const fn of cleanupFns) {
      try {
        fn();
      } catch {
        // A failing removeListener should not prevent the others from running.
        // This can happen if the global was replaced between install and detach.
      }
    }
  };
}
