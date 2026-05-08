import type { MessageEvent, TaskExtractionResult } from "@ask-thane/domain";

export interface LlmClient {
  extractTasksFromConversation(event: MessageEvent): Promise<TaskExtractionResult>;
}

export interface LlmClientOptions {
  provider: "openai" | "anthropic";
  model: string;
}

class StubLlmClient implements LlmClient {
  constructor(private readonly options: LlmClientOptions) {}

  async extractTasksFromConversation(event: MessageEvent): Promise<TaskExtractionResult> {
    return {
      tasks: [],
      reasoningSummary: `Stub ${this.options.provider}:${this.options.model} processed message ${event.messageId}`
    };
  }
}

export function createLlmClient(options: LlmClientOptions): LlmClient {
  return new StubLlmClient(options);
}
