import { defineConfig, globalIgnores } from 'eslint/config';
import { nodeConfig } from '@n8n/eslint-config/node';

export default defineConfig(
	globalIgnores(['node_modules/**', 'dist/**', 'packages/**']),
	nodeConfig,
	{
		files: ['scripts/**/*.mjs'],
		rules: {
			'@stylistic/linebreak-style': ['error', 'windows'],
		},
	},
);
