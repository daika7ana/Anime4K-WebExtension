import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Base recommended rules
  js.configs.recommended,

  // TypeScript recommended rules (not type-checked for a pragmatic baseline)
  ...tseslint.configs.recommended,

  // Global ignores
  {
    ignores: [
      'dist-*/',
      'node_modules/',
      'webpack.config.js',
      'src/test-setup.ts',
      'src/wgsl.d.ts',
    ],
  },

  // Source TypeScript files
  {
    files: ['src/**/*.ts'],
    rules: {
      // --- Relaxed rules for this codebase ---
      // console.log/warn are used extensively for diagnostics;
      // Terser strips them in production builds.
      'no-console': 'off',

      // Prefer 'any' to be explicit rather than implicit;
      // switching to strict mode would be a separate effort.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Non-null assertions (!) are used deliberately in a few places
      // (e.g., top-frame access after guard checks in content.ts).
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // Allow underscore-prefixed names for intentionally unused vars/args
      // (e.g., _keys in test mocks, _sender/_sendResponse in chrome callback signatures)
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Test files — mocks and jsdom DOM setup legitimately use `any` and `!`.
  // Tests don't need the same type-strictness as production source.
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
