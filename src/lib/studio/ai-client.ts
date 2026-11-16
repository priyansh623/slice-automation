import Anthropic from '@anthropic-ai/sdk';

/** The Anthropic client for Studio features that are not image analysis. Replaced in tests. */
export interface StudioMessagesClient { messages: { create(args: Anthropic.MessageCreateParamsNonStreaming, options?: { timeout?: number; maxRetries?: number }): Promise<Anthropic.Message> } }

let shared: Anthropic | null = null;
export const getStudioClient = (): StudioMessagesClient => (shared ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
export const aiConfigured = (): boolean => Boolean(process.env.ANTHROPIC_API_KEY);
