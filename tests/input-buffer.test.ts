import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { InputBuffer } from "../src/input-buffer.js";

describe("InputBuffer", () => {
  let buffer: InputBuffer;
  
  beforeEach(() => {
    buffer = new InputBuffer();
  });
  
  afterEach(() => {
    buffer.disable();
  });
  
  describe("push and pop", () => {
    it("should push and pop items in FIFO order", () => {
      buffer.push("first");
      buffer.push("second");
      buffer.push("third");
      
      assert.strictEqual(buffer.pop(), "first");
      assert.strictEqual(buffer.pop(), "second");
      assert.strictEqual(buffer.pop(), "third");
    });
    
    it("should return undefined when popping from empty buffer", () => {
      assert.strictEqual(buffer.pop(), undefined);
    });
  });
  
  describe("hasPending", () => {
    it("should return false when empty", () => {
      assert.strictEqual(buffer.hasPending(), false);
    });
    
    it("should return true when items are queued", () => {
      buffer.push("test");
      assert.strictEqual(buffer.hasPending(), true);
    });
    
    it("should return false after all items are popped", () => {
      buffer.push("test");
      buffer.pop();
      assert.strictEqual(buffer.hasPending(), false);
    });
  });
  
  describe("popAll", () => {
    it("should return all items and clear the buffer", () => {
      buffer.push("a");
      buffer.push("b");
      buffer.push("c");
      
      const items = buffer.popAll();
      assert.deepStrictEqual(items, ["a", "b", "c"]);
      assert.strictEqual(buffer.hasPending(), false);
    });
    
    it("should return empty array when buffer is empty", () => {
      const items = buffer.popAll();
      assert.deepStrictEqual(items, []);
    });
  });
  
  describe("getPendingCount", () => {
    it("should return correct count of pending items", () => {
      assert.strictEqual(buffer.getPendingCount(), 0);
      
      buffer.push("one");
      buffer.push("two");
      assert.strictEqual(buffer.getPendingCount(), 2);
      
      buffer.pop();
      assert.strictEqual(buffer.getPendingCount(), 1);
    });
    
    it("should not count cancel requests", () => {
      buffer.push("__CANCEL__");
      buffer.push("normal");
      assert.strictEqual(buffer.getPendingCount(), 1);
    });
    
    it("should not count pause requests", () => {
      buffer.push("__PAUSE__");
      buffer.push("normal");
      assert.strictEqual(buffer.getPendingCount(), 1);
    });
  });
  
  describe("cancel handling", () => {
    it("should detect cancel request", () => {
      buffer.push("__CANCEL__");
      assert.strictEqual(buffer.isCancelRequested(), true);
    });
    
    it("should not detect cancel when not present", () => {
      buffer.push("normal");
      assert.strictEqual(buffer.isCancelRequested(), false);
    });
    
    it("should consume cancel and remove it", () => {
      buffer.push("__CANCEL__");
      assert.strictEqual(buffer.consumeCancel(), true);
      assert.strictEqual(buffer.isCancelRequested(), false);
      assert.strictEqual(buffer.consumeCancel(), false);
    });
    
    it("should return false when consuming with no cancel", () => {
      assert.strictEqual(buffer.consumeCancel(), false);
    });
  });
  
  describe("pause handling", () => {
    it("should detect pause request", () => {
      buffer.push("__PAUSE__");
      assert.strictEqual(buffer.isPauseRequested(), true);
    });
    
    it("should not detect pause when not present", () => {
      buffer.push("normal");
      assert.strictEqual(buffer.isPauseRequested(), false);
    });
    
    it("should consume pause and remove it", () => {
      buffer.push("__PAUSE__");
      assert.strictEqual(buffer.consumePause(), true);
      assert.strictEqual(buffer.isPauseRequested(), false);
      assert.strictEqual(buffer.consumePause(), false);
    });
    
    it("should return false when consuming with no pause", () => {
      assert.strictEqual(buffer.consumePause(), false);
    });
    
    it("should handle both cancel and pause", () => {
      buffer.push("__CANCEL__");
      buffer.push("__PAUSE__");
      
      assert.strictEqual(buffer.isCancelRequested(), true);
      assert.strictEqual(buffer.isPauseRequested(), true);
      
      buffer.consumeCancel();
      assert.strictEqual(buffer.isCancelRequested(), false);
      assert.strictEqual(buffer.isPauseRequested(), true);
      
      buffer.consumePause();
      assert.strictEqual(buffer.isPauseRequested(), false);
    });
  });
  
  describe("enable/disable", () => {
    it("should be safe to call disable when not enabled", () => {
      buffer.disable();
      buffer.disable();
    });
    
    it("should be safe to call enable multiple times", () => {
      buffer.enable();
      buffer.enable();
      buffer.disable();
    });
  });
  
  describe("multiple operations", () => {
    it("should handle mixed operations correctly", () => {
      buffer.push("msg1");
      buffer.push("__CANCEL__");
      buffer.push("msg2");
      buffer.push("__PAUSE__");
      
      assert.strictEqual(buffer.hasPending(), true);
      assert.strictEqual(buffer.isCancelRequested(), true);
      assert.strictEqual(buffer.isPauseRequested(), true);
      assert.strictEqual(buffer.getPendingCount(), 2);
      
      const first = buffer.pop();
      assert.strictEqual(first, "msg1");
      
      buffer.consumeCancel();
      buffer.consumePause();
      
      assert.strictEqual(buffer.getPendingCount(), 1);
      assert.strictEqual(buffer.isCancelRequested(), false);
      assert.strictEqual(buffer.isPauseRequested(), false);
    });
  });
});
