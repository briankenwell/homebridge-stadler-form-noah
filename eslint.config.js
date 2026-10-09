import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      quotes: ['warn', 'single'],
      indent: ['warn', 2, { SwitchCase: 1 }],
      semi: ['warn', 'always'],
      'comma-dangle': ['warn', 'always-multiline'],
      'max-len': ['warn', 140],
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
