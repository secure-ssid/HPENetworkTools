export const CODEX_MODEL_OPTIONS = [
  { id: 'gpt-5.3-spark', label: 'Spark · fastest' },
  { id: 'gpt-5.6-luna', label: 'Luna · fast' },
  { id: 'gpt-5.6-terra', label: 'Terra · balanced' },
  { id: 'gpt-5.4', label: 'GPT-5.4 · legacy' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini · legacy quick' },
] as const;

export type CodexModelId = typeof CODEX_MODEL_OPTIONS[number]['id'];

export function isCodexModel(id: unknown): id is CodexModelId {
  return typeof id === 'string' && CODEX_MODEL_OPTIONS.some((model) => model.id === id);
}
