import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { InputBuffer } from "./repl.js";

describe("Mid-Task Input Flow", () => {
  let buffer: InputBuffer;
  
  beforeEach(() => {
    buffer = new InputBuffer();
  });
  
  afterEach(() => {
    buffer.disable();
  });
  
  describe("feedback injection flow", () => {
    it("should queue feedback and detect it after simulated command", async () => {
      buffer.push("please use a different approach");
      
      assert.strictEqual(buffer.hasPending(), true);
      
      const feedbackItems = buffer.popAll().filter(f => f !== "__CANCEL__" && f !== "__PAUSE__");
      assert.strictEqual(feedbackItems.length, 1);
      assert.strictEqual(feedbackItems[0], "please use a different approach");
    });
    
    it("should handle multiple feedback messages", async () => {
      buffer.push("first feedback");
      buffer.push("second feedback");
      
      const feedbackItems = buffer.popAll().filter(f => f !== "__CANCEL__" && f !== "__PAUSE__");
      assert.strictEqual(feedbackItems.length, 2);
      
      const combined = feedbackItems.join("\n");
      assert.ok(combined.includes("first feedback"));
      assert.ok(combined.includes("second feedback"));
    });
    
    it("should format feedback for LLM injection", () => {
      buffer.push("try a different API endpoint");
      
      const feedback = buffer.popAll().filter(f => f !== "__CANCEL__" && f !== "__PAUSE__").join("\n");
      const llmMessage = `USER FEEDBACK: ${feedback}`;
      
      assert.ok(llmMessage.startsWith("USER FEEDBACK:"));
      assert.ok(llmMessage.includes("try a different API endpoint"));
    });
  });
  
  describe("cancel flow", () => {
    it("should detect cancel request during execution", () => {
      buffer.push("__CANCEL__");
      
      assert.strictEqual(buffer.isCancelRequested(), true);
      assert.strictEqual(buffer.hasPending(), true);
    });
    
    it("should consume cancel and stop execution", () => {
      buffer.push("__CANCEL__");
      
      if (buffer.isCancelRequested()) {
        const wasCancelled = buffer.consumeCancel();
        assert.strictEqual(wasCancelled, true);
        assert.strictEqual(buffer.isCancelRequested(), false);
      }
    });
    
    it("should handle cancel with other messages", () => {
      buffer.push("some feedback");
      buffer.push("__CANCEL__");
      buffer.push("more feedback");
      
      assert.strictEqual(buffer.isCancelRequested(), true);
      
      buffer.consumeCancel();
      
      const remaining = buffer.popAll();
      assert.deepStrictEqual(remaining, ["some feedback", "more feedback"]);
    });
  });
  
  describe("pause flow", () => {
    it("should detect pause request during execution", () => {
      buffer.push("__PAUSE__");
      
      assert.strictEqual(buffer.isPauseRequested(), true);
      assert.strictEqual(buffer.hasPending(), true);
    });
    
    it("should consume pause and return paused state", () => {
      buffer.push("__PAUSE__");
      
      if (buffer.isPauseRequested()) {
        const wasPaused = buffer.consumePause();
        assert.strictEqual(wasPaused, true);
        assert.strictEqual(buffer.isPauseRequested(), false);
      }
    });
    
    it("should handle pause with other messages", () => {
      buffer.push("some feedback");
      buffer.push("__PAUSE__");
      buffer.push("more feedback");
      
      assert.strictEqual(buffer.isPauseRequested(), true);
      
      buffer.consumePause();
      
      const remaining = buffer.popAll();
      assert.deepStrictEqual(remaining, ["some feedback", "more feedback"]);
    });
    
    it("should prioritize pause check over feedback", () => {
      buffer.push("feedback before pause");
      buffer.push("__PAUSE__");
      
      if (buffer.isPauseRequested()) {
        buffer.consumePause();
        assert.strictEqual(buffer.isPauseRequested(), false);
      }
      
      const remaining = buffer.popAll();
      assert.deepStrictEqual(remaining, ["feedback before pause"]);
    });
    
    it("should handle both pause and cancel", () => {
      buffer.push("__PAUSE__");
      buffer.push("__CANCEL__");
      
      assert.strictEqual(buffer.isPauseRequested(), true);
      assert.strictEqual(buffer.isCancelRequested(), true);
      
      buffer.consumePause();
      buffer.consumeCancel();
      
      assert.strictEqual(buffer.isPauseRequested(), false);
      assert.strictEqual(buffer.isCancelRequested(), false);
    });
  });
  
  describe("bash block replacement flow", () => {
    it("should correctly merge old and new bash blocks", () => {
      const originalBlocks = ["cmd1", "cmd2", "cmd3"];
      const newBlocks = ["new_cmd1", "new_cmd2"];
      const currentIndex = 0;
      
      const remaining = originalBlocks.slice(currentIndex + 1);
      const merged = [...remaining, ...newBlocks];
      
      assert.deepStrictEqual(merged, ["cmd2", "cmd3", "new_cmd1", "new_cmd2"]);
    });
    
    it("should handle empty new blocks", () => {
      const originalBlocks = ["cmd1", "cmd2"];
      const newBlocks: string[] = [];
      const currentIndex = 0;
      
      const merged = [...originalBlocks.slice(currentIndex + 1), ...newBlocks];
      
      assert.deepStrictEqual(merged, ["cmd2"]);
    });
  });
  
  describe("edge cases", () => {
    it("should handle empty feedback gracefully", () => {
      buffer.push("");
      buffer.push("   ");
      
      const feedbackItems = buffer.popAll().filter(f => f !== "__CANCEL__" && f !== "__PAUSE__" && f.trim());
      assert.strictEqual(feedbackItems.length, 0);
    });
    
    it("should handle special characters in feedback", () => {
      buffer.push("use $VAR and `backticks` and 'quotes'");
      
      const feedback = buffer.pop();
      assert.strictEqual(feedback, "use $VAR and `backticks` and 'quotes'");
    });
    
    it("should handle very long feedback", () => {
      const longFeedback = "a".repeat(10000);
      buffer.push(longFeedback);
      
      const feedback = buffer.pop();
      assert.strictEqual(feedback?.length, 10000);
    });
    
    it("should handle unicode in feedback", () => {
      buffer.push("你好 🎉 مرحبا");
      
      const feedback = buffer.pop();
      assert.strictEqual(feedback, "你好 🎉 مرحبا");
    });
  });
  
  describe("rapid input scenario", () => {
    it("should handle rapid successive pushes", () => {
      for (let i = 0; i < 100; i++) {
        buffer.push(`feedback ${i}`);
      }
      
      assert.strictEqual(buffer.getPendingCount(), 100);
      
      const all = buffer.popAll();
      assert.strictEqual(all.length, 100);
      assert.strictEqual(all[0], "feedback 0");
      assert.strictEqual(all[99], "feedback 99");
    });
  });
});
