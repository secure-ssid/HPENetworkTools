// Flat ESLint config.
//
// Scope is deliberate: this repo already has a 1,700-test suite and a strict
// typecheck, so lint is here to catch the classes of bug those two do NOT —
// floating promises, React hook dependency mistakes, accidental shadowing —
// rather than to relitigate formatting. Stylistic rules are left off on
// purpose; churning 69k lines to satisfy a formatter would bury real findings.
//
// Type-aware linting is enabled for src/ only. It needs a TypeScript program
// per workspace and is the slow part, but `no-floating-promises` alone is
// worth it in a codebase whose whole job is brokering async vendor writes.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'web/public/**',
      // Authored HTML/JS design prototypes, not application source. They are
      // the visual reference the screens were ported from and run in a browser
      // with their own globals.
      'design/**',
      'eslint.config.mjs',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // `const { a: _a, ...rest } = obj` is this codebase's idiom for building
      // a payload minus certain keys (see buildWlanReplacementPayload in
      // server/src/planes/central.ts). The omitted bindings are the point.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          ignoreRestSiblings: true,
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Terminal/webhook code parses ANSI escapes and rejects control characters
  // in operator input, so matching control characters is the intent, not a
  // typo. Scoped to the files that legitimately do it.
  {
    files: [
      'server/src/services/terminal.ts',
      'server/src/services/centralWebhooks.ts',
      'shared/webhooks.ts',
    ],
    rules: { 'no-control-regex': 'off' },
  },

  // Type-aware rules, restricted to first-party source.
  {
    files: ['server/src/**/*.ts', 'web/src/**/*.{ts,tsx}', 'shared/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The portal's core risk is an async vendor call whose result nobody
      // waits for — a write that silently never happened, or an error that
      // never reaches the operator. That is exactly this rule.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },

  // React screens. The 6 pre-existing `react-hooks/exhaustive-deps` disable
  // comments in this repo were inert until now — this is the plugin they were
  // written for.
  {
    files: ['web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // eslint-plugin-react-hooks v7 ships the React Compiler correctness
      // rules. They are informative but they flag ~30 long-standing patterns
      // in screens that are covered by 641 passing tests, so they run as
      // warnings: real signal, without CI blocking on a pre-existing style of
      // effect that nobody is changing today. Promote to 'error' once the
      // screens in Phase 3.5 are decomposed.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  {
    files: ['server/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Tests assert on deliberately malformed input and stub vendor shapes, so
  // `any` and non-null assertions are load-bearing there rather than sloppy.
  {
    files: ['**/*.test.{ts,tsx}', 'server/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
);
