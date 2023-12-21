import { Request } from 'express';
import { Service } from 'typedi';
import { v4 as uuid } from 'uuid';
import config from '@/config';
import type { Role } from '@db/entities/Role';
import { RoleRepository } from '@db/repositories/role.repository';
import { SettingsRepository } from '@db/repositories/settings.repository';
import { UserRepository } from '@db/repositories/user.repository';
import { ActiveWorkflowRunner } from '@/ActiveWorkflowRunner';
import { eventBus } from '@/eventbus/MessageEventBus/MessageEventBus';
import { License } from '@/License';
import { LICENSE_FEATURES, inE2ETests } from '@/constants';
import { NoAuthRequired, Patch, Post, RestController } from '@/decorators';
import type { UserSetupPayload } from '@/requests';
import type { BooleanLicenseFeature, IPushDataType } from '@/Interfaces';
import { MfaService } from '@/Mfa/mfa.service';
import { Push } from '@/push';
import { CacheService } from '@/services/cache.service';
import { PasswordUtility } from '@/services/password.utility';

if (!inE2ETests) {
	console.error('E2E endpoints only allowed during E2E tests');
	process.exit(1);
}

const tablesToTruncate = [
	'auth_identity',
	'auth_provider_sync_history',
	'event_destinations',
	'shared_workflow',
	'shared_credentials',
	'webhook_entity',
	'workflows_tags',
	'credentials_entity',
	'tag_entity',
	'workflow_statistics',
	'workflow_entity',
	'execution_entity',
	'settings',
	'installed_packages',
	'installed_nodes',
	'user',
	'role',
	'variables',
];

type ResetRequest = Request<
	{},
	{},
	{
		owner: UserSetupPayload;
		members: UserSetupPayload[];
		admin: UserSetupPayload;
	}
>;

type PushRequest = Request<
	{},
	{},
	{
		type: IPushDataType;
		sessionId: string;
		data: object;
	}
>;

@Service()
@NoAuthRequired()
@RestController('/e2e')
export class E2EController {
	private enabledFeatures: Record<BooleanLicenseFeature, boolean> = {
		[LICENSE_FEATURES.SHARING]: false,
		[LICENSE_FEATURES.LDAP]: false,
		[LICENSE_FEATURES.SAML]: false,
		[LICENSE_FEATURES.LOG_STREAMING]: false,
		[LICENSE_FEATURES.ADVANCED_EXECUTION_FILTERS]: false,
		[LICENSE_FEATURES.SOURCE_CONTROL]: false,
		[LICENSE_FEATURES.VARIABLES]: false,
		[LICENSE_FEATURES.API_DISABLED]: false,
		[LICENSE_FEATURES.EXTERNAL_SECRETS]: false,
		[LICENSE_FEATURES.SHOW_NON_PROD_BANNER]: false,
		[LICENSE_FEATURES.WORKFLOW_HISTORY]: false,
		[LICENSE_FEATURES.DEBUG_IN_EDITOR]: false,
		[LICENSE_FEATURES.BINARY_DATA_S3]: false,
		[LICENSE_FEATURES.MULTIPLE_MAIN_INSTANCES]: false,
		[LICENSE_FEATURES.WORKER_VIEW]: false,
		[LICENSE_FEATURES.ADVANCED_PERMISSIONS]: false,
	};

	constructor(
		license: License,
		private readonly roleRepo: RoleRepository,
		private readonly settingsRepo: SettingsRepository,
		private readonly userRepo: UserRepository,
		private readonly workflowRunner: ActiveWorkflowRunner,
		private readonly mfaService: MfaService,
		private readonly cacheService: CacheService,
		private readonly push: Push,
		private readonly passwordUtility: PasswordUtility,
	) {
		license.isFeatureEnabled = (feature: BooleanLicenseFeature) =>
			this.enabledFeatures[feature] ?? false;
	}

	@Post('/reset')
	async reset(req: ResetRequest) {
		this.resetFeatures();
		await this.resetLogStreaming();
		await this.removeActiveWorkflows();
		await this.truncateAll();
		await this.resetCache();
		await this.setupUserManagement(req.body.owner, req.body.members, req.body.admin);
	}

	@Post('/push')
	async pushSend(req: PushRequest) {
		this.push.send(req.body.type, req.body.data, req.body.sessionId);
	}

	@Patch('/feature')
	setFeature(req: Request<{}, {}, { feature: BooleanLicenseFeature; enabled: boolean }>) {
		const { enabled, feature } = req.body;
		this.enabledFeatures[feature] = enabled;
	}

	@Patch('/queue-mode')
	async setQueueMode(req: Request<{}, {}, { enabled: boolean }>) {
		const { enabled } = req.body;
		config.set('executions.mode', enabled ? 'queue' : 'regular');
		return { success: true, message: `Queue mode set to ${config.getEnv('executions.mode')}` };
	}

	private resetFeatures() {
		for (const feature of Object.keys(this.enabledFeatures)) {
			this.enabledFeatures[feature as BooleanLicenseFeature] = false;
		}
	}

	private async removeActiveWorkflows() {
		this.workflowRunner.removeAllQueuedWorkflowActivations();
		await this.workflowRunner.removeAll();
	}

	private async resetLogStreaming() {
		for (const id in eventBus.destinations) {
			await eventBus.removeDestination(id, false);
		}
	}

	private async truncateAll() {
		for (const table of tablesToTruncate) {
			try {
				const { connection } = this.roleRepo.manager;
				await connection.query(
					`DELETE FROM ${table}; DELETE FROM sqlite_sequence WHERE name=${table};`,
				);
			} catch (error) {
				console.warn('Dropping Table for E2E Reset error: ', error);
			}
		}
	}

	private async setupUserManagement(
		owner: UserSetupPayload,
		members: UserSetupPayload[],
		admin: UserSetupPayload,
	) {
		const roles: Array<[Role['name'], Role['scope']]> = [
			['owner', 'global'],
			['member', 'global'],
			['admin', 'global'],
			['owner', 'workflow'],
			['owner', 'credential'],
			['user', 'credential'],
			['editor', 'workflow'],
		];

		const [{ id: globalOwnerRoleId }, { id: globalMemberRoleId }, { id: globalAdminRoleId }] =
			await this.roleRepo.save(
				roles.map(([name, scope], index) => ({ name, scope, id: (index + 1).toString() })),
			);

		const instanceOwner = {
			id: uuid(),
			...owner,
			password: await this.passwordUtility.hash(owner.password),
			globalRoleId: globalOwnerRoleId,
		};

		if (owner?.mfaSecret && owner.mfaRecoveryCodes?.length) {
			const { encryptedRecoveryCodes, encryptedSecret } =
				this.mfaService.encryptSecretAndRecoveryCodes(owner.mfaSecret, owner.mfaRecoveryCodes);
			instanceOwner.mfaSecret = encryptedSecret;
			instanceOwner.mfaRecoveryCodes = encryptedRecoveryCodes;
		}

		const adminUser = {
			id: uuid(),
			...admin,
			password: await this.passwordUtility.hash(admin.password),
			globalRoleId: globalAdminRoleId,
		};

		const users = [];

		users.push(instanceOwner, adminUser);

		for (const { password, ...payload } of members) {
			users.push(
				this.userRepo.create({
					id: uuid(),
					...payload,
					password: await this.passwordUtility.hash(password),
					globalRoleId: globalMemberRoleId,
				}),
			);
		}

		await this.userRepo.insert(users);

		await this.settingsRepo.update(
			{ key: 'userManagement.isInstanceOwnerSetUp' },
			{ value: 'true' },
		);

		config.set('userManagement.isInstanceOwnerSetUp', true);
	}

	private async resetCache() {
		await this.cacheService.reset();
	}
}
