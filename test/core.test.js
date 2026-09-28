import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobalErrorHandler, normalizeErrorEvent, detectEnvironment } from '../src/core.js';

describe('detectEnvironment', () => {
  test('returns "node" when process.on is available', () => {
    assert.equal(detectEnvironment(), 'node');
  });
});

describe('normalizeErrorEvent', () => {
  test('normalizes a Node uncaughtException Error', () => {
    const err = new Error('boom');
    const result = normalizeErrorEvent(err, 'error', 'node');
    assert.equal(result.type, 'error');
    assert.equal(result.message, 'boom');
    assert.equal(result.source, 'process');
    assert.equal(result.error, err);
    assert.equal(result.raw, err);
  });

  test('normalizes a Node unhandledRejection with a string reason', () => {
    const result = normalizeErrorEvent('string rejection', 'unhandledrejection', 'node');
    assert.equal(result.type, 'unhandledrejection');
    assert.equal(result.message, 'string rejection');
    assert.equal(result.error, null);
    assert.equal(result.source, 'process');
  });

  test('normalizes a Node unhandledRejection with a number reason', () => {
    const result = normalizeErrorEvent(42, 'unhandledrejection', 'node');
    assert.equal(result.message, '42');
    assert.equal(result.error, null);
  });

  test('normalizes a Node unhandledRejection with null reason', () => {
    const result = normalizeErrorEvent(null, 'unhandledrejection', 'node');
    assert.equal(result.message, 'Unhandled promise rejection');
    assert.equal(result.error, null);
  });

  test('normalizes a browser error event with an Error object', () => {
    const err = new TypeError('type fail');
    const fakeEvent = { error: err, message: 'type fail' };
    const result = normalizeErrorEvent(fakeEvent, 'error', 'browser');
    assert.equal(result.type, 'error');
    assert.equal(result.message, 'type fail');
    assert.equal(result.error, err);
    assert.equal(result.source, 'window');
    assert.equal(result.raw, fakeEvent);
  });

  test('normalizes a cross-origin browser error event with no error object', () => {
    // Browsers send a plain Event with message "Script error." and no .error.
    const fakeEvent = { message: 'Script error.' };
    const result = normalizeErrorEvent(fakeEvent, 'error', 'browser');
    assert.equal(result.message, 'Script error.');
    assert.equal(result.error, null);
  });

  test('normalizes a browser unhandledrejection event with reason', () => {
    const err = new Error('rejected');
    const fakeEvent = { reason: err };
    const result = normalizeErrorEvent(fakeEvent, 'unhandledrejection', 'browser');
    assert.equal(result.type, 'unhandledrejection');
    assert.equal(result.message, 'rejected');
    assert.equal(result.error, err);
    assert.equal(result.source, 'window');
  });

  test('falls back to default message when nothing is available', () => {
    const result = normalizeErrorEvent(undefined, 'error', 'node');
    assert.equal(result.message, 'Unhandled error');
  });

  test('extracts message from objects with a .message property', () => {
    const obj = { message: 'custom message', code: 500 };
    const result = normalizeErrorEvent(obj, 'unhandledrejection', 'node');
    assert.equal(result.message, 'custom message');
    assert.equal(result.error, null);
  });

  test('handles symbol reasons', () => {
    const sym = Symbol('reject-symbol');
    const result = normalizeErrorEvent(sym, 'unhandledrejection', 'node');
    assert.equal(result.message, 'Symbol(reject-symbol)');
  });

  test('returns unknown source for unknown environment', () => {
    const result = normalizeErrorEvent(new Error('x'), 'error', 'unknown');
    assert.equal(result.source, 'unknown');
  });
});

describe('installGlobalErrorHandler', () => {
  // We invoke only the listeners that installGlobalErrorHandler added,
  // rather than using process.emit, because emitting
  // uncaughtException/unhandledRejection through Node's event system
  // causes the test runner to treat them as real failures. We also avoid
  // calling pre-existing listeners (e.g. the test runner's own) that would
  // report errors.

  function getNewListeners(name, countBefore) {
    return process.listeners(name).slice(countBefore);
  }

  test('throws if callback is not a function', () => {
    assert.throws(
      () => installGlobalErrorHandler(null),
      { name: 'TypeError' }
    );
  });

  test('routes uncaughtException to the callback with normalized fields', () => {
    const events = [];
    const before = process.listenerCount('uncaughtException');
    const detach = installGlobalErrorHandler((ev) => events.push(ev));
    try {
      for (const fn of getNewListeners('uncaughtException', before)) fn(new Error('uncaught-test'));
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'error');
      assert.equal(events[0].message, 'uncaught-test');
      assert.equal(events[0].source, 'process');
      assert.ok(events[0].error instanceof Error);
    } finally {
      detach();
    }
  });

  test('routes unhandledRejection to the callback with normalized fields', () => {
    const events = [];
    const before = process.listenerCount('unhandledRejection');
    const detach = installGlobalErrorHandler((ev) => events.push(ev));
    try {
      for (const fn of getNewListeners('unhandledRejection', before)) fn('string-reason');
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'unhandledrejection');
      assert.equal(events[0].message, 'string-reason');
      assert.equal(events[0].error, null);
    } finally {
      detach();
    }
  });

  test('detach removes the listeners so no further events arrive', () => {
    const events = [];
    const before = process.listenerCount('uncaughtException');
    const detach = installGlobalErrorHandler((ev) => events.push(ev));
    detach();
    assert.equal(process.listenerCount('uncaughtException'), before);
    // No listeners from this install remain, so nothing to invoke.
    assert.equal(events.length, 0);
  });

  test('detach is idempotent', () => {
    const detach = installGlobalErrorHandler(() => {});
    assert.doesNotThrow(() => detach());
    assert.doesNotThrow(() => detach());
  });

  test('multiple installs each route independently', () => {
    const eventsA = [];
    const eventsB = [];
    const before = process.listenerCount('unhandledRejection');
    const detachA = installGlobalErrorHandler((ev) => eventsA.push(ev));
    const detachB = installGlobalErrorHandler((ev) => eventsB.push(ev));
    try {
      // Only call the listeners added by our two installs.
      const added = getNewListeners('unhandledRejection', before);
      for (const fn of added) fn(99);
      assert.equal(eventsA.length, 1);
      assert.equal(eventsB.length, 1);
      assert.equal(eventsA[0].message, '99');
      assert.equal(eventsB[0].message, '99');
    } finally {
      detachA();
      detachB();
    }
  });

  test('detaching one handler does not affect another', () => {
    const eventsA = [];
    const eventsB = [];
    const before = process.listenerCount('unhandledRejection');
    const detachA = installGlobalErrorHandler((ev) => eventsA.push(ev));
    const detachB = installGlobalErrorHandler((ev) => eventsB.push(ev));
    detachA();
    // Only call listeners added by detachB (the one still attached).
    const remaining = getNewListeners('unhandledRejection', before);
    for (const fn of remaining) fn('only-b');
    assert.equal(eventsA.length, 0);
    assert.equal(eventsB.length, 1);
    detachB();
  });

  test('returns a detach function', () => {
    const detach = installGlobalErrorHandler(() => {});
    assert.equal(typeof detach, 'function');
    detach();
  });
});
