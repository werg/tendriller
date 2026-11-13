// Small interface every realtime voice provider implements. The voice layer
// (../index.ts) never touches provider wire formats; it only sees these types.

export interface ToolDef { name: string; description: string; parameters: object }

export interface ToolCall { name: string; callId: string; args: any }

export interface ProviderHooks {
  /** Model called a tool. Return the output (any JSON value) that goes back to the model. */
  onToolCall(call: ToolCall): Promise<unknown>;
  /** Transcript of what the user said (live audio only). */
  onUserTranscript(text: string): void;
  /** Text or audio transcript of what the model said. */
  onReply(text: string): void;
  /** A model response chain ended (after any tool calls and their follow-up responses). */
  onTurnDone(info: { toolCalls: number }): void;
  /** User started / stopped speaking (live audio only). */
  onSpeech?(speaking: boolean): void;
  /** Session ended (closed by either side or failed). */
  onClose(reason?: string): void;
}

export interface ConnectOptions {
  /** Provider-specific connection info returned by POST P_tendril/voice/session. */
  session: Record<string, any>;
  /** Open the microphone for a continuous live conversation. */
  mic: boolean;
  tools: ToolDef[];
  hooks: ProviderHooks;
  /** Whether model audio should play (honours _prefs.audio). */
  audioOut: boolean;
}

export interface RealtimeSession {
  readonly mic: boolean;
  /** Send a typed or locally-recognised utterance; the model answers in audio or text. */
  sendText(text: string, opts?: { modality?: "audio" | "text" }): void;
  updateTools(tools: ToolDef[]): void;
  setAudioOut(on: boolean): void;
  close(): void;
}

export interface RealtimeProvider {
  name: string;
  connect(opts: ConnectOptions): Promise<RealtimeSession>;
}
