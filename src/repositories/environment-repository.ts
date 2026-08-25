import type { HoppscotchClient } from '../client.js';
import type {
  UserEnvironment,
  TeamEnvironment,
  CreateEnvironmentInput,
  UpdateEnvironmentInput,
  EnvironmentVariable,
} from '../types.js';
import { ApiType } from '../config.js';
import { HoppscotchError } from '../types.js';
import { redactSecrets } from '../utils/request-executor.js';
import * as queries from '../graphql/queries.js';
import * as mutations from '../graphql/mutations.js';

/** Placeholder substituted for a secret variable's value on the OUTBOUND read path. */
export const SECRET_PLACEHOLDER = '<secret hidden>';

/** Plaintext `secret: true` values in a serialized blob, used to scrub a backend error that echoes a submitted secret. */
function submittedSecretValues(variablesStr: string | undefined): string[] {
  if (!variablesStr) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(variablesStr);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const v of parsed) {
    if (v && (v as Record<string, unknown>).secret === true) {
      for (const f of ['value', 'currentValue', 'initialValue']) {
        const val = (v as Record<string, unknown>)[f];
        if (typeof val === 'string' && val) out.push(val);
      }
    }
  }
  return out;
}

/**
 * Guard the WRITE path against the redaction placeholder being persisted. A
 * model that lists envs, copies a `secret: true` var (now showing
 * SECRET_PLACEHOLDER instead of the real value), and submits the list back on
 * create/update would otherwise overwrite the real secret with the placeholder.
 * We reject that explicitly rather than silently clobbering. Callers should omit
 * the secret var (or the whole variables list) to leave it unchanged, or pass
 * its real value.
 */
export function assertNoRedactionPlaceholder(variables: EnvironmentVariable[]): void {
  const offender = variables.find((v) => v && v.value === SECRET_PLACEHOLDER);
  if (offender) {
    throw new HoppscotchError(
      `Refusing to write the secret-redaction placeholder ("${SECRET_PLACEHOLDER}") as the value of ` +
        `variable "${offender.key}". This placeholder is what a secret variable shows when read back; ` +
        `writing it would overwrite the real secret. To leave a secret unchanged, omit that variable ` +
        `(or the entire variables list) from the update; to change it, pass the new real value.`
    );
  }
}

/**
 * Mask secret-flagged environment-variable values before they leave the MCP
 * boundary. Hoppscotch marks sensitive vars with `secret: true`; the server must
 * not pass their plaintext value (or currentValue/initialValue) back to the
 * model/transcript. Pure + boundary-only: call it when SHAPING a response, never
 * on the repository reads that updateEnvironment reuses to preserve unchanged
 * fields (redacting there would write the placeholder back, destroying the real
 * secret). A proper array with no secret vars passes through unchanged; an
 * unparseable or non-array blob fails closed (one redaction marker) since we
 * can't prove it's secret-free.
 */
export function redactEnvSecrets<T extends { variables: string }>(env: T): T {
  let vars: Array<Record<string, unknown>>;
  try {
    vars = JSON.parse(env.variables) as Array<Record<string, unknown>>;
  } catch {
    return {
      ...env,
      variables: JSON.stringify([
        { key: '<unavailable>', value: SECRET_PLACEHOLDER, secret: true },
      ]),
    };
  }
  if (!Array.isArray(vars)) {
    return {
      ...env,
      variables: JSON.stringify([
        { key: '<unavailable>', value: SECRET_PLACEHOLDER, secret: true },
      ]),
    };
  }
  if (!vars.some((v) => v && v.secret === true)) {
    return env;
  }
  const SECRET_FIELDS = ['value', 'currentValue', 'initialValue'];
  const redacted = vars.map((v) => {
    if (!v || v.secret !== true) return v;
    const copy: Record<string, unknown> = { ...v };
    for (const f of SECRET_FIELDS) {
      if (f in copy) copy[f] = SECRET_PLACEHOLDER;
    }
    return copy;
  });
  return { ...env, variables: JSON.stringify(redacted) };
}

/**
 * Repository for managing environments (user and team).
 *
 * User environments
 * ─────────────────
 * • Self-Hosted: available via me { environments { ... } } resolver field.
 * • Cloud: not supported as of now; the MCP gates them client-side.
 *   Listing user environments on Cloud returns an empty array.
 *
 * Team environments
 * ─────────────────
 * • Both backends support CRUD mutations for team environments.
 * • Listing team environments: available on both backends via the
 *   team(teamID) { teamEnvironments { ... } } resolver field.
 */
export class EnvironmentRepository {
  constructor(private client: HoppscotchClient) {}

  private isCloud(): boolean {
    return this.client.getConfig().apiType === ApiType.CLOUD;
  }

  // ─── Variable serialization ────────────────────────────────────────────────

  private serializeVariables(variables: EnvironmentVariable[]): string {
    // Block the redaction placeholder from being persisted, see
    // assertNoRedactionPlaceholder. All create/update paths funnel caller-
    // supplied variables through here, so this is the single chokepoint.
    assertNoRedactionPlaceholder(variables);
    return JSON.stringify(variables);
  }

  private parseVariables(variablesJson: string): EnvironmentVariable[] {
    try {
      return JSON.parse(variablesJson) as EnvironmentVariable[];
    } catch {
      return [];
    }
  }

  /** Run an env mutation, scrubbing any submitted secret the backend echoes back in an error. */
  private async submitWithSecretScrub<R>(
    variablesStr: string | undefined,
    op: () => Promise<R>
  ): Promise<R> {
    try {
      return await op();
    } catch (err) {
      const secrets = submittedSecretValues(variablesStr);
      if (secrets.length && err instanceof Error) {
        const scrubbed = redactSecrets(err.message, secrets);
        if (scrubbed !== err.message) {
          const code = err instanceof HoppscotchError ? err.code : undefined;
          const statusCode = err instanceof HoppscotchError ? err.statusCode : undefined;
          throw new HoppscotchError(scrubbed, code, statusCode);
        }
      }
      throw err;
    }
  }

  // ─── User Environments ────────────────────────────────────────────────────

  /**
   * List personal environments for the authenticated user.
   * Self-Hosted: me { environments } resolver field.
   * Cloud: not supported as of now; returns an empty array.
   */
  async getUserEnvironments(): Promise<UserEnvironment[]> {
    if (this.isCloud()) {
      return [];
    }

    const result = await this.client.graphql<{
      me: { environments: UserEnvironment[] };
    }>(queries.GET_USER_ENVIRONMENTS);

    return result.me?.environments || [];
  }

  /**
   * Create a personal environment.
   * Not supported on Cloud as of now; gated client-side.
   */
  async createUserEnvironment(data: CreateEnvironmentInput): Promise<UserEnvironment> {
    if (this.isCloud()) {
      throw new Error(
        'User environments are not supported on Hoppscotch Cloud. Use team environments instead.'
      );
    }

    const variables = this.serializeVariables(data.variables);

    const result = await this.submitWithSecretScrub(variables, () =>
      this.client.graphql<{
        createUserEnvironment: UserEnvironment;
      }>(mutations.CREATE_USER_ENVIRONMENT, {
        name: data.name,
        variables,
      })
    );

    return result.createUserEnvironment;
  }

  /**
   * Update a personal environment.
   * Not supported on Cloud as of now; gated client-side.
   */
  async updateUserEnvironment(
    environmentId: string,
    data: UpdateEnvironmentInput
  ): Promise<UserEnvironment> {
    if (this.isCloud()) {
      throw new Error(
        'User environments are not supported on Hoppscotch Cloud. Use team environments instead.'
      );
    }

    // name and variables are String! (NON_NULL) on the SH mutation. If the
    // caller omits one we must read the current value and pass it through;
    // sending '' / '[]' as a default would silently wipe data the user did
    // not ask to change.
    let name = data.name;
    let variablesStr = data.variables ? this.serializeVariables(data.variables) : undefined;

    if (name === undefined || variablesStr === undefined) {
      const all = await this.getUserEnvironments();
      const current = all.find((e) => e.id === environmentId);
      if (!current) {
        throw new Error(`User environment ${environmentId} not found`);
      }
      name = name ?? current.name;
      variablesStr = variablesStr ?? current.variables;
    }

    const result = await this.submitWithSecretScrub(variablesStr, () =>
      this.client.graphql<{
        updateUserEnvironment: UserEnvironment;
      }>(mutations.UPDATE_USER_ENVIRONMENT, {
        id: environmentId,
        name,
        variables: variablesStr,
      })
    );

    return result.updateUserEnvironment;
  }

  /**
   * Delete a personal environment.
   * Not supported on Cloud as of now; gated client-side.
   */
  async deleteUserEnvironment(environmentId: string): Promise<boolean> {
    if (this.isCloud()) {
      throw new Error(
        'User environments are not supported on Hoppscotch Cloud. Use team environments instead.'
      );
    }

    await this.client.graphql(mutations.DELETE_USER_ENVIRONMENT, {
      id: environmentId,
    });

    return true;
  }

  // ─── Team Environments ────────────────────────────────────────────────────

  /**
   * List all environments for a team.
   * Both: team(teamID) { teamEnvironments { ... } }
   */
  async getTeamEnvironments(teamId: string): Promise<TeamEnvironment[]> {
    const result = await this.client.graphql<{
      team: { teamEnvironments: TeamEnvironment[] };
    }>(queries.GET_TEAM_ENVIRONMENTS, { teamID: teamId });

    return result.team?.teamEnvironments || [];
  }

  /**
   * Get a specific team environment by ID.
   * No single-by-ID GQL query exists, so this lists all environments for the team and filters.
   * Requires teamId; throws if not found.
   */
  async getTeamEnvironment(environmentId: string, teamId: string): Promise<TeamEnvironment> {
    const all = await this.getTeamEnvironments(teamId);
    const env = all.find((e) => e.id === environmentId);
    if (!env) {
      throw new Error(`Team environment ${environmentId} not found`);
    }
    return env;
  }

  /**
   * Create a team environment.
   * Both: createTeamEnvironment(teamID, name, variables)
   */
  async createTeamEnvironment(
    teamId: string,
    data: CreateEnvironmentInput
  ): Promise<TeamEnvironment> {
    const variables = this.serializeVariables(data.variables);

    const result = await this.submitWithSecretScrub(variables, () =>
      this.client.graphql<{
        createTeamEnvironment: TeamEnvironment;
      }>(mutations.CREATE_TEAM_ENVIRONMENT, {
        teamID: teamId,
        name: data.name,
        variables,
      })
    );

    return result.createTeamEnvironment;
  }

  /**
   * Update a team environment.
   * Both: updateTeamEnvironment(id, name!, variables!)
   * name and variables are required, so fetch current values if not provided.
   */
  async updateTeamEnvironment(
    environmentId: string,
    data: UpdateEnvironmentInput
  ): Promise<TeamEnvironment> {
    // name and variables are NON_NULL on the GQL mutation. If the caller
    // omits one, fetch the current value and pass it through; sending '' or
    // '[]' as a default would silently wipe data the user did not ask to
    // change. Requires defaultTeamId to be configured because there's no
    // single-by-ID team-env query; we list and filter.
    let name = data.name;
    let variablesStr = data.variables ? this.serializeVariables(data.variables) : undefined;

    if (name === undefined || variablesStr === undefined) {
      const config = this.client.getConfig();
      const teamId = config.defaultTeamId;
      if (!teamId) {
        throw new Error(
          'updateTeamEnvironment requires both name and variables when HOPPSCOTCH_DEFAULT_TEAM_ID is not configured. ' +
            'Either pass both fields, or set HOPPSCOTCH_DEFAULT_TEAM_ID so the server can look up the current values.'
        );
      }
      const all = await this.getTeamEnvironments(teamId);
      const current = all.find((e) => e.id === environmentId);
      if (!current) {
        throw new Error(`Team environment ${environmentId} not found in team ${teamId}`);
      }
      name = name ?? current.name;
      variablesStr = variablesStr ?? current.variables;
    }

    const result = await this.submitWithSecretScrub(variablesStr, () =>
      this.client.graphql<{
        updateTeamEnvironment: TeamEnvironment;
      }>(mutations.UPDATE_TEAM_ENVIRONMENT, {
        id: environmentId,
        name,
        variables: variablesStr,
      })
    );

    return result.updateTeamEnvironment;
  }

  /**
   * Delete a team environment.
   * Both: deleteTeamEnvironment(id)
   */
  async deleteTeamEnvironment(environmentId: string): Promise<boolean> {
    await this.client.graphql(mutations.DELETE_TEAM_ENVIRONMENT, {
      id: environmentId,
    });

    return true;
  }

  // ─── Utility ──────────────────────────────────────────────────────────────

  getEnvironmentVariables(environment: UserEnvironment | TeamEnvironment): EnvironmentVariable[] {
    return this.parseVariables(environment.variables);
  }
}
