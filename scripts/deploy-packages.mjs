#!/usr/bin/env node
/**
 * Windows-compatible package packing script for n8n
 * Packs all publishable (non-private) packages to .deploy folder as .tgz archives
 * with proper dependency ordering for file-based installation
 */

import { $, echo, fs, chalk } from 'zx';
import path from 'path';
import glob from 'fast-glob';
import { fileURLToPath } from 'url';

// #region ===== Configuration =====

// Platform detection
const isWindows = process.platform === 'win32';
const isCI = process.env.CI === 'true';
const dryRun = process.argv.includes('--dry-run');
const testMode = process.argv.includes('--test');
const skipBuild = process.argv.includes('--no-build');

// Configure zx
$.verbose = !isCI;
process.env.FORCE_COLOR = isCI ? '0' : '1';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const isInScriptsDir = path.basename(scriptDir) === 'scripts';
const rootDir = isInScriptsDir ? path.join(scriptDir, '..') : scriptDir;

const config = {
	deployDir: path.join(rootDir, '.deploy'),
	rootDir: rootDir,
};

// Backend patches to keep during packing
const PATCHES_TO_KEEP = ['pdfjs-dist', 'pkce-challenge', 'bull'];

// #endregion ===== Configuration =====

// #region ===== Helper Functions =====

const timers = new Map();

function startTimer(name) {
	timers.set(name, Date.now());
}

function getElapsedTime(name) {
	const start = timers.get(name);
	if (!start) return 0;
	return Math.floor((Date.now() - start) / 1000);
}

function formatDuration(seconds) {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;

	if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
	if (minutes > 0) return `${minutes}m ${secs}s`;
	return `${secs}s`;
}

function formatFileSize(bytes) {
	if (bytes === 0) return '0B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let size = bytes;
	let unitIndex = 0;

	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex++;
	}

	return `${Math.round(size * 10) / 10}${units[unitIndex]}`;
}

function printHeader(title) {
	echo('');
	echo(chalk.blue.bold(`===== ${title} =====`));
}

function printDivider() {
	echo(chalk.gray('-----------------------------------------------'));
}

// #endregion ===== Helper Functions =====

// #region ===== Package Discovery & Sorting =====

/**
 * Find all publishable packages in the workspace
 */
async function findPublishablePackages() {
	echo(chalk.yellow('INFO: Discovering publishable packages...'));

	let packageJsonFiles = [];
	try {
		packageJsonFiles = await glob('**/package.json', {
			cwd: config.rootDir,
			ignore: ['**/node_modules/**', 'compiled/**', 'dist/**', '.pnpm/**', '.deploy/**', '**/template/**'],
			absolute: false,
			dot: false,
			onlyFiles: true,
		});
	} catch (error) {
		echo(chalk.red(`ERROR: Failed to discover packages: ${error.message}`));
		throw error;
	}

	const publishablePackages = [];

	for (const relPath of packageJsonFiles) {
		const fullPath = path.join(config.rootDir, relPath);
		try {
			const content = await fs.readFile(fullPath, 'utf8');
			const packageJson = JSON.parse(content);

			// Include packages that are not marked as private
			if (packageJson.private !== true && packageJson.name) {
				publishablePackages.push({
					name: packageJson.name,
					path: relPath,
					dirPath: path.dirname(relPath),
					packageJson: packageJson,
				});
			}
		} catch (error) {
			echo(chalk.yellow(`⚠️  Warning: Could not read ${relPath}: ${error.message}`));
		}
	}

	echo(chalk.green(`✅ Found ${publishablePackages.length} publishable packages`));

	// In test mode, only pack first 3 packages
	if (testMode) {
		echo(chalk.cyan('TEST MODE: Limiting to first 3 packages'));
		return publishablePackages.slice(0, 3);
	}

	return publishablePackages;
}

/**
 * Build dependency graph and perform topological sort
 */
function topologicalSort(packages) {
	echo(chalk.yellow('INFO: Building dependency graph...'));

	// Create a map of package names to package objects
	const packageMap = new Map();
	for (const pkg of packages) {
		packageMap.set(pkg.name, pkg);
	}

	// Build adjacency list (dependencies)
	const graph = new Map();
	const inDegree = new Map();

	for (const pkg of packages) {
		graph.set(pkg.name, []);
		inDegree.set(pkg.name, 0);
	}

	// Build the graph
	for (const pkg of packages) {
		const deps = [
			...Object.keys(pkg.packageJson.dependencies || {}),
			...Object.keys(pkg.packageJson.devDependencies || {}),
		];

		for (const dep of deps) {
			// Only consider workspace packages
			if (packageMap.has(dep)) {
				graph.get(dep).push(pkg.name);
				inDegree.set(pkg.name, inDegree.get(pkg.name) + 1);
			}
		}
	}

	// Kahn's algorithm for topological sort
	const sorted = [];
	const queue = [];

	// Find all packages with no dependencies
	for (const [pkgName, degree] of inDegree.entries()) {
		if (degree === 0) {
			queue.push(pkgName);
		}
	}

	while (queue.length > 0) {
		const current = queue.shift();
		sorted.push(current);

		for (const dependent of graph.get(current)) {
			inDegree.set(dependent, inDegree.get(dependent) - 1);
			if (inDegree.get(dependent) === 0) {
				queue.push(dependent);
			}
		}
	}

	// Check for cycles
	if (sorted.length !== packages.length) {
		echo(
			chalk.yellow(
				'⚠️  Warning: Circular dependencies detected, using partial topological order',
			),
		);
		// Add remaining packages in original order
		for (const pkg of packages) {
			if (!sorted.includes(pkg.name)) {
				sorted.push(pkg.name);
			}
		}
	}

	// Convert back to package objects in sorted order
	const sortedPackages = sorted.map((name) => packageMap.get(name));

	echo(chalk.green(`✅ Dependency graph built, packing order determined`));
	return sortedPackages;
}

// #endregion ===== Package Discovery & Sorting =====

// #region ===== Main Process =====

async function main() {
	printHeader('n8n Package Packing (Windows-Compatible)');
	echo(`INFO: Deploy Directory: ${config.deployDir}`);
	echo(`INFO: Platform: ${process.platform} (${process.arch})`);
	if (dryRun) {
		echo(chalk.cyan('INFO: DRY RUN MODE - No actual packing will be performed'));
	}
	if (testMode) {
		echo(chalk.cyan('INFO: TEST MODE - Only first 3 packages will be packed'));
	}
	if (skipBuild) {
		echo(chalk.cyan('INFO: SKIP BUILD MODE - Build phase will be skipped'));
	}
	printDivider();

	startTimer('total');

	// Step 1: Find publishable packages
	const packages = await findPublishablePackages();
	if (packages.length === 0) {
		echo(chalk.yellow('⚠️  No publishable packages found'));
		process.exit(0);
	}
	printDivider();

	// Step 2: Topological sort
	const sortedPackages = topologicalSort(packages);
	echo(chalk.cyan('Packing order:'));
	sortedPackages.forEach((pkg, index) => {
		echo(chalk.gray(`  ${index + 1}. ${pkg.name}`));
	});
	printDivider();

	if (dryRun) {
		echo(chalk.cyan('DRY RUN: Would pack the above packages in this order'));
		echo(chalk.green('✅ Dry run completed'));
		process.exit(0);
	}

	// Step 3: Pre-Pack Cleanup
	echo(chalk.yellow('INFO: Pre-packing cleanup...'));

	// Clean deploy directory
	echo(chalk.yellow(`INFO: Cleaning deploy directory: ${config.deployDir}...`));
	await fs.remove(config.deployDir);
	await fs.ensureDir(config.deployDir);

	// Backup package.json files
	const allPackageJsonFiles = await glob('**/package.json', {
		cwd: config.rootDir,
		ignore: ['**/node_modules/**', 'compiled/**', 'dist/**', '.pnpm/**', '.deploy/**'],
		absolute: false,
		dot: false,
	});

	if (process.env.CI !== 'true') {
		echo(chalk.yellow(`INFO: Backing up ${allPackageJsonFiles.length} package.json files...`));
		for (const file of allPackageJsonFiles) {
			const fullPath = path.join(config.rootDir, file);
			await fs.copy(fullPath, `${fullPath}.bak`);
		}
	}

	// Run FE trim script
	try {
		$.cwd = config.rootDir;
		await $`node .github/scripts/trim-fe-packageJson.js`;
		$.cwd = undefined;
		echo(chalk.green('✅ FE package.json trimmed'));
	} catch (error) {
		echo(chalk.yellow(`⚠️  Warning: FE trim script failed: ${error.message}`));
	}

	// Clean patches in root package.json
	echo(chalk.yellow('INFO: Cleaning patches in root package.json...'));
	const rootPackageJsonPath = path.join(config.rootDir, 'package.json');

	if (await fs.pathExists(rootPackageJsonPath)) {
		try {
			const content = await fs.readFile(rootPackageJsonPath, 'utf8');
			const packageJson = JSON.parse(content);

			if (packageJson.pnpm && packageJson.pnpm.patchedDependencies) {
				const filteredPatches = {};
				for (const [key, value] of Object.entries(packageJson.pnpm.patchedDependencies)) {
					const shouldKeep = PATCHES_TO_KEEP.some((prefix) => key.startsWith(prefix));
					if (shouldKeep) {
						filteredPatches[key] = value;
					}
				}
				packageJson.pnpm.patchedDependencies = filteredPatches;
			}

			await fs.writeFile(rootPackageJsonPath, JSON.stringify(packageJson, null, 2), 'utf8');
			echo(chalk.green('✅ Kept backend patches: ' + PATCHES_TO_KEEP.join(', ')));
		} catch (error) {
			echo(chalk.red(`ERROR: Failed to clean patches: ${error.message}`));
			process.exit(1);
		}
	}

	printDivider();

	// Step 4: Pack packages
	echo(chalk.yellow('INFO: Starting package packing...'));
	startTimer('pack');

	const packedPackages = [];
	const failedPackages = [];

	for (const pkg of sortedPackages) {
		const pkgTimer = `pack_${pkg.name}`;
		startTimer(pkgTimer);

		echo('');
		echo(chalk.cyan(`📦 Packing: ${pkg.name}`));

		try {
			const packageDir = path.join(config.rootDir, pkg.dirPath);

			// Run pnpm pack in the package directory
			$.cwd = packageDir;
			process.env.NODE_ENV = 'production';

			const packResult = await $`pnpm pack --pack-gzip-level=9`;

			// The output of pnpm pack is the filename
			const packOutput = packResult.stdout.trim();
			const tgzFile = packOutput.split('\n').pop(); // Get last line (filename)

			const sourceTgz = path.join(packageDir, tgzFile);
			const targetTgz = path.join(config.deployDir, tgzFile);

			// Move the tgz file to deploy directory
			await fs.move(sourceTgz, targetTgz);

			// Get file size
			const stats = await fs.stat(targetTgz);
			const size = formatFileSize(stats.size);
			const packTime = getElapsedTime(pkgTimer);

			packedPackages.push({
				name: pkg.name,
				file: tgzFile,
				size: size,
				sizeBytes: stats.size,
				duration: packTime,
			});

			echo(chalk.green(`  ✅ Packed as ${tgzFile} (${size}) in ${formatDuration(packTime)}`));
		} catch (error) {
			const packTime = getElapsedTime(pkgTimer);
			failedPackages.push({
				name: pkg.name,
				error: error.message,
				duration: packTime,
			});
			echo(chalk.red(`  ❌ Failed: ${error.message}`));
		}
	}

	$.cwd = undefined;
	const packTime = getElapsedTime('pack');
	printDivider();

	// Step 5: Restore package.json files
	if (process.env.CI !== 'true') {
		echo(chalk.yellow('INFO: Restoring package.json files...'));
		for (const file of allPackageJsonFiles) {
			const fullPath = path.join(config.rootDir, file);
			const backupPath = `${fullPath}.bak`;
			if (await fs.pathExists(backupPath)) {
				await fs.move(backupPath, fullPath, { overwrite: true });
			}
		}
		echo(chalk.green('✅ package.json files restored'));
	}
	printDivider();

	// Step 6: Generate global packing manifest
	let totalSize = 0;
	for (const pkg of packedPackages) {
		totalSize += pkg.sizeBytes;
	}

	const globalManifest = {
		packingTime: new Date().toISOString(),
		platform: process.platform,
		arch: process.arch,
		totalSize: formatFileSize(totalSize),
		totalSizeBytes: totalSize,
		totalDuration: getElapsedTime('total'),
		packingOrder: sortedPackages.map((p) => p.name),
		packages: packedPackages.map((p) => ({
			name: p.name,
			file: p.file,
			size: p.size,
		})),
		successfulPackages: packedPackages.length,
		failedPackages: failedPackages.length,
	};

	await fs.writeJson(path.join(config.deployDir, 'packing-manifest.json'), globalManifest, {
		spaces: 2,
	});

	// Step 7: Print summary
	echo('');
	echo(chalk.green.bold('================ PACKING SUMMARY ================'));

	if (packedPackages.length > 0) {
		echo(chalk.green(`✅ Successfully packed ${packedPackages.length} packages`));
		echo('');
		echo(chalk.blue('📦 Packed Packages:'));
		packedPackages.forEach((pkg) => {
			echo(chalk.gray(`   ${pkg.name} → ${pkg.file} (${pkg.size})`));
		});
	}

	if (failedPackages.length > 0) {
		echo('');
		echo(chalk.red(`❌ Failed to pack ${failedPackages.length} packages`));
		echo('');
		echo(chalk.red('💥 Failed Packages:'));
		failedPackages.forEach((pkg) => {
			echo(chalk.red(`   ${pkg.name}: ${pkg.error}`));
		});
	}

	echo('');
	echo(chalk.blue('📊 Statistics:'));
	echo(`   Total Packages:      ${sortedPackages.length}`);
	echo(chalk.green(`   Successful:          ${packedPackages.length}`));
	if (failedPackages.length > 0) {
		echo(chalk.red(`   Failed:              ${failedPackages.length}`));
	}
	echo(`   Total Size:          ${formatFileSize(totalSize)}`);
	echo(`   Packing Time:        ${formatDuration(packTime)}`);
	echo(`   Total Time:          ${formatDuration(getElapsedTime('total'))}`);
	echo('');
	echo(chalk.blue('📋 Deploy Directory:'));
	echo(`   ${path.resolve(config.deployDir)}`);
	echo('');
	echo(chalk.blue('📄 Manifest:'));
	echo(`   ${path.resolve(config.deployDir, 'packing-manifest.json')}`);
	echo(chalk.green.bold('=================================================='));

	// Exit with appropriate code
	process.exit(failedPackages.length > 0 ? 1 : 0);
}

// #endregion ===== Main Process =====

// Run the script
main().catch((error) => {
	console.error(chalk.red('\n🛑 PACKING FAILED!'));
	console.error(chalk.red(`Error: ${error.message}`));
	console.error(error.stack);
	process.exit(1);
});
