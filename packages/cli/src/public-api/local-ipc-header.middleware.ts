import type { RequestHandler } from 'express';

// [CUSTOM-FORK] License Activation: Allow local IPC requests without API key
const checkLocalhostIP = (ip: string): boolean =>
	ip === '127.0.0.1' ||
	ip === '::1' ||
	ip === '::ffff:127.0.0.1' ||
	ip.startsWith('127.') ||
	ip === 'localhost';

const checkLocalhostHostname = (hostname: string): boolean =>
	hostname === 'localhost' ||
	hostname.startsWith('127.') ||
	hostname.startsWith('localhost:') ||
	hostname === '[::1]' ||
	hostname.startsWith('[::1]:');

const checkForwardedLocalhost = (forwardedFor: string | undefined): boolean =>
	!!forwardedFor &&
	(forwardedFor === '127.0.0.1' ||
		forwardedFor === '::1' ||
		forwardedFor.startsWith('127.') ||
		forwardedFor === 'localhost');

export const localIpcHeaderMiddleware: RequestHandler = (req, _res, next) => {
	const ip = req.ip ?? req.socket.remoteAddress ?? '';
	const hostname = req.hostname ?? req.get('host') ?? '';
	const forwardedFor = req.get('x-forwarded-for');

	if (
		(checkLocalhostIP(ip) ||
			checkLocalhostHostname(hostname) ||
			checkForwardedLocalhost(forwardedFor)) &&
		req.headers['x-n8n-api-key'] === undefined
	) {
		req.headers['x-n8n-api-key'] = 'local-ipc';
	}
	return next();
};
// [CUSTOM-FORK] End License Activation
