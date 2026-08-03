import { describe, expect, it } from 'vitest';
import { AssistantProviderTimeoutError } from '../src/services/assistant/openaiCompatible';
import { classifyChatFailure } from '../src/routes/chat';

describe('chat provider failure responses', () => {
  it('returns a distinct safe gateway-timeout response for a provider timeout', () => {
    expect(classifyChatFailure(new AssistantProviderTimeoutError(15_000))).toEqual({
      status: 504,
      error: 'assistant provider timed out — try again shortly',
      logMessage: 'assistant provider timed out after 15000ms',
    });
  });

  it('keeps all other provider failures generic and never returns their message', () => {
    const failure = classifyChatFailure(new Error('assistant provider HTTP 401: Bearer sk-secret'));
    expect(failure.status).toBe(502);
    expect(failure.error).toBe('assistant request failed upstream — check the MCP/LLM configuration');
    expect(failure.error).not.toContain('sk-secret');
    expect(failure.logMessage).not.toContain('sk-secret');
  });
});
