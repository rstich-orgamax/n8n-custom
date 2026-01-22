import type { AuthenticatedRequest } from '@n8n/db';
import { GLOBAL_OWNER_ROLE, UserRepository } from '@n8n/db';
import { Service } from '@n8n/di';

import { EventService } from '@/events/event.service';
import { LastActiveAtService } from './last-active-at.service';

@Service()
export class LocalIpcAuthService {
	constructor(
		private readonly userRepository: UserRepository,
		private readonly eventService: EventService,
		private readonly lastActiveAtService: LastActiveAtService,
	) {}

	// [CUSTOM-FORK] License Activation: Check if request is from localhost (IPC)
	isLocalhostRequest(req: AuthenticatedRequest): boolean {
		const ip = req.ip || req.socket.remoteAddress || '';
		const hostname = req.hostname || req.get('host') || '';

		// Check for localhost IPs
		const isLocalhostIP =
			ip === '127.0.0.1' ||
			ip === '::1' ||
			ip === '::ffff:127.0.0.1' ||
			ip.startsWith('127.') ||
			ip === 'localhost';

		// Check for localhost hostname
		const isLocalhostHostname =
			hostname === 'localhost' ||
			hostname.startsWith('127.') ||
			hostname.startsWith('localhost:') ||
			hostname === '[::1]' ||
			hostname.startsWith('[::1]:');

		// Also check X-Forwarded-For header (might be set by reverse proxy)
		const forwardedFor = req.get('x-forwarded-for');
		const isForwardedLocalhost =
			forwardedFor &&
			(forwardedFor === '127.0.0.1' ||
				forwardedFor === '::1' ||
				forwardedFor.startsWith('127.') ||
				forwardedFor === 'localhost');

		return isLocalhostIP || isLocalhostHostname || !!isForwardedLocalhost;
	}
	// [CUSTOM-FORK] End License Activation

	// [CUSTOM-FORK] License Activation: Authenticate local IPC request without API key
	async authenticateLocalRequest(req: AuthenticatedRequest, version: string): Promise<boolean> {
		// Check if request is from localhost (IPC communication within same service)
		if (!this.isLocalhostRequest(req)) {
			return false;
		}

		// For local IPC requests, use the instance owner user without API key
		const owner = await this.userRepository.findOne({
			where: { role: { slug: GLOBAL_OWNER_ROLE.slug } },
			relations: ['role'],
		});

		if (!owner || owner.disabled) {
			return false;
		}

		this.eventService.emit('public-api-invoked', {
			userId: owner.id,
			path: req.path,
			method: req.method,
			apiVersion: version,
		});

		req.user = owner;

		// TODO: ideally extract that to a dedicated middleware, but express-openapi-validator
		// does not support middleware between authentication and operators
		void this.lastActiveAtService.updateLastActiveIfStale(owner.id);

		return true;
	}
	// [CUSTOM-FORK] End License Activation
}
