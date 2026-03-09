import type {
  Engine,
  FileAttachment,
  Harness,
} from "../harness";
import { executeWithBusyRetries, executeStreamingWithBusyRetries, reconnectStreamingWithRetries } from "./common";
export { executeStreamingWithBusyRetries, reconnectStreamingWithRetries };

export type ModeExecutionParams = {
  harness: Harness;
  instruction: string;
  message: string;
  threadKey: string;
  requestId: string;
  files: FileAttachment[];
  userId?: string;
  model?: string | null;
  engine?: Engine | null;
};

export async function runModeExecution(params: ModeExecutionParams): Promise<string> {
  return executeWithBusyRetries({
    threadKey: params.threadKey,
    message: params.message,
    harness: params.harness,
    requestId: params.requestId,
    files: params.files.length > 0 ? params.files : undefined,
    userId: params.userId,
    model: params.model,
    engine: params.engine,
  });
}
