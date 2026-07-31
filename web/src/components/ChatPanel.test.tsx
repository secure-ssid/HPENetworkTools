/**
 * web/src/components/ChatPanel.test.tsx — component tests for the assistant
 * chat drawer (web/src/screens/ChatPanel.tsx).
 *
 * The api client is mocked at the module boundary (no real fetch); ChatPanel
 * renders inside a MemoryRouter because it calls useNavigate for the
 * "Connected systems → Assistant" escape hatch.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ChatPanel from '../screens/ChatPanel';
import { getChatStatus, postChat } from '../api/client';
import type { ChatResult, ChatStatus } from '../api/client';

vi.mock('../api/client', () => ({
  getChatStatus: vi.fn(),
  postChat: vi.fn(),
}));

const mockedGetChatStatus = vi.mocked(getChatStatus);
const mockedPostChat = vi.mocked(postChat);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <ChatPanel open onOpenChange={() => {}} />
    </MemoryRouter>,
  );
}

const CONFIGURED_STATUS: ChatStatus = {
  configured: { mcp: true, llm: true },
  writeMode: false,
  mcpReachable: true,
};

describe('ChatPanel', () => {
  it('shows the cancellation error honestly and re-enables the composer when postChat reports the abort', async () => {
    mockedGetChatStatus.mockResolvedValue(CONFIGURED_STATUS);
    const pendingChat = deferred<ChatResult>();
    mockedPostChat.mockReturnValue(pendingChat.promise);

    renderPanel();

    // Configured → the composer is offered.
    const input = (await screen.findByLabelText('Message the assistant')) as HTMLInputElement;
    const sendButton = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true); // nothing typed yet

    fireEvent.change(input, { target: { value: 'how many APs are down?' } });
    expect(sendButton.disabled).toBe(false);
    fireEvent.click(sendButton);

    // While the request is in flight the composer is locked and the panel
    // says so.
    await waitFor(() => expect(input.disabled).toBe(true));
    expect(sendButton.disabled).toBe(true);
    expect(screen.getByText('working…')).toBeTruthy();

    // The server never answered in time — postChat resolves with the abort
    // message from client.ts.
    pendingChat.resolve({
      ok: false,
      error: 'no answer within two minutes — the request was cancelled',
    });

    // The error is surfaced verbatim, not swallowed.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Chat failed');
    expect(alert.textContent).toContain(
      'no answer within two minutes — the request was cancelled',
    );

    // Pending cleared: the composer re-enables so the user can retry, and the
    // sent user message stays in the stream.
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(screen.queryByText('working…')).toBeNull();
    expect(screen.getByText('how many APs are down?')).toBeTruthy();

    // The conversation (user turn only — no assistant reply) went to postChat.
    expect(mockedPostChat).toHaveBeenCalledTimes(1);
    expect(mockedPostChat).toHaveBeenCalledWith(
      [{ role: 'user', content: 'how many APs are down?' }],
      false,
    );

    // A retry is actually possible: typing re-arms the Send button.
    fireEvent.change(input, { target: { value: 'try again' } });
    expect(sendButton.disabled).toBe(false);
  });

  /**
   * The error banner is cleared by the next send. What is left behind is a
   * question sitting in the stream with no reply under it, which reads as an
   * assistant that ignored it rather than a request that never arrived.
   */
  it('labels a turn the assistant never answered, and hands the question back for a retry', async () => {
    mockedGetChatStatus.mockResolvedValue(CONFIGURED_STATUS);
    mockedPostChat.mockResolvedValue({ ok: false, error: 'the backend is unreachable' });

    renderPanel();
    const input = (await screen.findByLabelText('Message the assistant')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'how many APs are down?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByText(/NOT ANSWERED/)).toBeTruthy());
    // What was asked stays on screen — hiding it would be its own lie.
    expect(screen.getByText('how many APs are down?')).toBeTruthy();
    // And retrying does not mean retyping it off the screen.
    expect(input.value).toBe('how many APs are down?');
  });

  // Replaying an unanswered turn puts two user turns back to back with nothing
  // between them: not what the operator asked, and not a shape to hand a model.
  it('does not resend an unanswered turn as context on the next attempt', async () => {
    mockedGetChatStatus.mockResolvedValue(CONFIGURED_STATUS);
    mockedPostChat.mockResolvedValue({ ok: false, error: 'the backend is unreachable' });

    renderPanel();
    const input = (await screen.findByLabelText('Message the assistant')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'first question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByText(/NOT ANSWERED/)).toBeTruthy());

    mockedPostChat.mockResolvedValue({ ok: true, reply: 'four', transcript: [] });
    fireEvent.change(input, { target: { value: 'second question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByText('four')).toBeTruthy());
    expect(mockedPostChat).toHaveBeenLastCalledWith(
      [{ role: 'user', content: 'second question' }],
      false,
    );
    // The failed turn is gone from the stream once its question is superseded.
    expect(screen.queryByText(/NOT ANSWERED/)).toBeNull();
  });

  it('shows the not-configured empty state instead of a composer when MCP/LLM are unconfigured', async () => {
    mockedGetChatStatus.mockResolvedValue({
      configured: { mcp: false, llm: false },
      writeMode: false,
      mcpReachable: false,
    });

    renderPanel();

    expect(await screen.findByText('The assistant is not configured')).toBeTruthy();
    expect(
      screen.getByText('Configure MCP + LLM in Connected systems → Assistant.'),
    ).toBeTruthy();
    expect(screen.getByText('mcp not configured')).toBeTruthy();
    expect(screen.getByText('llm not configured')).toBeTruthy();

    // No composer in the not-configured state.
    expect(screen.queryByLabelText('Message the assistant')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(mockedPostChat).not.toHaveBeenCalled();
  });

  it('shows the backend-offline empty state when the status probe returns null', async () => {
    mockedGetChatStatus.mockResolvedValue(null);

    renderPanel();

    expect(await screen.findByText('The assistant is not configured')).toBeTruthy();
    expect(
      screen.getByText(
        'The portal backend is offline — the assistant needs it to reach centralmcp.',
      ),
    ).toBeTruthy();

    expect(screen.queryByLabelText('Message the assistant')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(mockedPostChat).not.toHaveBeenCalled();
  });
});
