// hub/src/orchestrator/proof-github.ts
// PTYCAP-05 (D-12): the READ-ONLY ProofGithub adapter over the GitHub App transport.
//
// The hub proposes nothing here, it only verifies: every request is a GET issued through
// an injectable request function (default: githubApiRequest, which throws GitHubApiError
// carrying `.status`). Credentials live in the transport; this module never reads env.

import { githubApiRequest } from '../auth/github-app.ts';
import {
  ProofGithubError,
  type CheckState,
  type CompareResult,
  type EffectiveRule,
  type PermissionProbe,
  type ProofGithub,
  type PullSummary,
  type RepoInfo,
  type RulesetDetail,
} from './proof-types.ts';

export type ProofRequestFn = (installationId: number, method: 'GET', path: string) => Promise<any>;

export interface ProofGithubDeps {
  request?: ProofRequestFn;
}

const enc = encodeURIComponent;
const PULL_PAGE_SIZE = 50;
/** 50 x 40 = 2000 PRs: a throwaway repo never needs more; beyond it the scan is declared incomplete. */
const PULL_PAGE_CAP = 40;

function malformed(what: string): ProofGithubError {
  return new ProofGithubError('unavailable', null, `github response malformed: ${what}`);
}

/** 403 -> forbidden, 404 -> not_found, anything else (incl. non-HTTP errors) -> unavailable. */
function mapError(e: unknown): ProofGithubError {
  if (e instanceof ProofGithubError) return e;
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    const kind = status === 403 ? 'forbidden' : status === 404 ? 'not_found' : 'unavailable';
    return new ProofGithubError(kind, status, (e as Error).message);
  }
  return new ProofGithubError('unavailable', null, e instanceof Error ? e.message : String(e));
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw malformed(what);
  return v;
};
const params = (v: unknown): Record<string, unknown> | null => (isObj(v) ? v : null);

export function makeProofGithub(opts: { installationId: number | string }, deps: ProofGithubDeps = {}): ProofGithub {
  const installationId = Number(opts.installationId);
  const request: ProofRequestFn = deps.request ?? githubApiRequest;
  const base = (owner: string, repo: string) => `/repos/${enc(owner)}/${enc(repo)}`;

  const get = async (path: string): Promise<any> => {
    try {
      return await request(installationId, 'GET', path);
    } catch (e) {
      throw mapError(e);
    }
  };

  return {
    async getRepo(owner, repo): Promise<RepoInfo> {
      const r = await get(base(owner, repo));
      if (!isObj(r)) throw malformed('repo');
      return { fullName: str(r.full_name, 'repo.full_name'), defaultBranch: str(r.default_branch, 'repo.default_branch') };
    },

    async getBranchHeadSha(owner, repo, branch) {
      const r = await get(`${base(owner, repo)}/branches/${enc(branch)}`);
      return str(r?.commit?.sha, 'branch.commit.sha');
    },

    async getEffectiveBranchRules(owner, repo, branch): Promise<EffectiveRule[]> {
      const r = await get(`${base(owner, repo)}/rules/branches/${enc(branch)}`);
      if (!Array.isArray(r)) throw malformed('rules');
      return r.map((x) => {
        if (!isObj(x)) throw malformed('rule');
        return {
          type: str(x.type, 'rule.type'),
          rulesetId: typeof x.ruleset_id === 'number' ? x.ruleset_id : null,
          rulesetSourceType: typeof x.ruleset_source_type === 'string' ? x.ruleset_source_type : null,
          parameters: params(x.parameters),
        };
      });
    },

    async getRuleset(owner, repo, rulesetId): Promise<RulesetDetail> {
      if (!Number.isInteger(rulesetId)) throw malformed('ruleset id');
      const r = await get(`${base(owner, repo)}/rulesets/${rulesetId}?includes_parents=true`);
      if (!isObj(r)) throw malformed('ruleset');
      const rules = Array.isArray(r.rules) ? r.rules : [];
      return {
        id: typeof r.id === 'number' ? r.id : rulesetId,
        name: typeof r.name === 'string' ? r.name : '',
        target: str(r.target, 'ruleset.target'),
        sourceType: str(r.source_type, 'ruleset.source_type'),
        enforcement: str(r.enforcement, 'ruleset.enforcement'),
        // GitHub returns bypass_actors only to callers with write access to the ruleset:
        // absent means "not visible", never "empty".
        bypassActors: Array.isArray(r.bypass_actors) ? r.bypass_actors : null,
        conditions: r.conditions ?? null,
        rules: rules.map((x: any) => {
          if (!isObj(x)) throw malformed('ruleset.rules[]');
          return { type: str(x.type, 'ruleset.rules[].type'), parameters: params(x.parameters) };
        }),
        updatedAt: typeof r.updated_at === 'string' ? r.updated_at : null,
      };
    },

    async compare(owner, repo, baseRef, head): Promise<CompareResult> {
      const r = await get(`${base(owner, repo)}/compare/${enc(baseRef)}...${enc(head)}?per_page=1`);
      const s = r?.status;
      if (s !== 'identical' && s !== 'ahead' && s !== 'behind' && s !== 'diverged') throw malformed('compare.status');
      if (typeof r.ahead_by !== 'number' || typeof r.behind_by !== 'number') throw malformed('compare counts');
      return { status: s, aheadBy: r.ahead_by, behindBy: r.behind_by };
    },

    async listPulls(owner, repo, since): Promise<PullSummary[]> {
      // QC round 2 (codex #5): PAGINATE. Newest-first, so every PR created since `since` is on a
      // prefix of the pages: stop at the first page that is short (the list is exhausted) or whose
      // last PR predates `since` (everything after it is older). Hitting the page cap without either
      // is an incomplete scan and FAILS CLOSED (throws; the verifier then stays pending, never green).
      const sinceMs = since == null ? NaN : (since instanceof Date ? since.getTime() : Date.parse(since));
      const out: PullSummary[] = [];
      for (let page = 1; ; page++) {
        if (page > PULL_PAGE_CAP) throw malformed('pulls pagination incomplete');
        const r = await get(
          `${base(owner, repo)}/pulls?state=all&sort=created&direction=desc&per_page=${PULL_PAGE_SIZE}${page > 1 ? `&page=${page}` : ''}`,
        );
        if (!Array.isArray(r)) throw malformed('pulls');
        let lastCreated = NaN;
        for (const p of r) {
          if (!isObj(p)) throw malformed('pull');
          const headRef = str(p.head?.ref, 'pull.head.ref');
          const mergedAt = typeof p.merged_at === 'string' && p.merged_at ? p.merged_at : null;
          out.push({
            number: p.number,
            htmlUrl: str(p.html_url, 'pull.html_url'),
            state: str(p.state, 'pull.state'),
            merged: mergedAt !== null,
            mergedAt,
            headRef,
            headSha: str(p.head?.sha, 'pull.head.sha'),
            baseRef: str(p.base?.ref, 'pull.base.ref'),
            draft: p.draft === true,
            // head.repo is null when the fork was deleted; the verifier treats null as foreign.
            headRepoFullName: typeof p.head?.repo?.full_name === 'string' ? p.head.repo.full_name : null,
            authorLogin: typeof p.user?.login === 'string' ? p.user.login : null,
            createdAt: typeof p.created_at === 'string' ? p.created_at : null,
          });
          lastCreated = typeof p.created_at === 'string' ? Date.parse(p.created_at) : NaN;
        }
        if (r.length < PULL_PAGE_SIZE) return out; // exhausted
        if (Number.isFinite(sinceMs) && Number.isFinite(lastCreated) && lastCreated < sinceMs) return out; // reached pre-arm PRs
      }
    },

    async getCheckState(owner, repo, sha): Promise<CheckState> {
      const b = base(owner, repo);
      const [runs, status] = await Promise.all([
        get(`${b}/commits/${enc(sha)}/check-runs?per_page=100`),
        get(`${b}/commits/${enc(sha)}/status?per_page=100`),
      ]);
      if (!Array.isArray(runs?.check_runs) || !Array.isArray(status?.statuses)) throw malformed('check state');
      const checkRuns = runs.check_runs.map((c: any) => ({
        name: str(c?.name, 'check_run.name'),
        status: str(c?.status, 'check_run.status'),
        conclusion: typeof c?.conclusion === 'string' ? c.conclusion : null,
      }));
      const statuses = status.statuses.map((s: any) => ({
        context: str(s?.context, 'status.context'),
        state: str(s?.state, 'status.state'),
      }));
      const truncated =
        (typeof runs.total_count === 'number' && runs.total_count > checkRuns.length) ||
        (typeof status.total_count === 'number' && status.total_count > statuses.length);
      return { checkRuns, statuses, truncated };
    },

    async listWorkflowFiles(owner, repo, ref) {
      const r = await get(`${base(owner, repo)}/contents/.github/workflows?ref=${enc(ref)}`);
      if (!Array.isArray(r)) throw malformed('workflows');
      return r
        .map((f) => (isObj(f) && typeof f.name === 'string' ? f.name : ''))
        .filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'));
    },

    async getCollaboratorPermission(owner, repo, username) {
      const r = await get(`${base(owner, repo)}/collaborators/${enc(username)}/permission`);
      return str(r?.permission, 'collaborator.permission');
    },

    async probePermissions(owner, repo): Promise<PermissionProbe> {
      const b = base(owner, repo);
      const can = async (path: string) => {
        try {
          await get(path);
          return true;
        } catch {
          return false;
        }
      };
      let branch: string;
      try {
        branch = (await this.getRepo(owner, repo)).defaultBranch;
      } catch {
        return { administrationRead: false, checksRead: false, statusesRead: false, pullsRead: false, contentsRead: false };
      }
      const [administrationRead, checksRead, statusesRead, pullsRead, contentsRead] = await Promise.all([
        can(`${b}/rulesets?per_page=1`),
        can(`${b}/commits/${enc(branch)}/check-runs?per_page=1`),
        can(`${b}/commits/${enc(branch)}/status?per_page=1`),
        can(`${b}/pulls?per_page=1`),
        can(`${b}/branches/${enc(branch)}`),
      ]);
      return { administrationRead, checksRead, statusesRead, pullsRead, contentsRead };
    },
  };
}
