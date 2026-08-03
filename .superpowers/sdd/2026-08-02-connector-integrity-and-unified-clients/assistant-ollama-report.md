# Ollama tool-call compatibility report

- Root cause: `chatLoop` replayed model messages with `content: null`; Ollama 0.30.11 rejects that outbound OpenAI-compatible message shape.
- RED: `npm run test -w server -- tests/mcpChat.test.ts` failed only the new compatibility assertion, receiving `null` instead of `''`.
- Fix: normalize empty assistant retry and tool-call replay messages to `content: ''`, preserving `tool_calls`, tool results, and transcript entries.
- GREEN: focused suite passed 16/16 tests; `npm run typecheck -w server` passed.
- Full server suite: 2431/2450 passed; 19 unrelated failures in `routes.test.ts` and `clearpassServiceDetail.test.ts` reflect concurrent connector-route changes outside this task's scope.
- Whitespace: `git diff --check -- server/src/services/mcpChat.ts server/tests/mcpChat.test.ts` passed.
