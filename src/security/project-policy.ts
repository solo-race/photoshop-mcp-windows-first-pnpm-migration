import { lstat, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface TaskGrant {
  id: string;
  expires_at: string;
  tools: string[];
  documents: string[];
  allow_new_documents?: boolean;
  destructive_tools?: string[];
  overwrite_paths?: string[];
  output_paths?: string[];
}
export interface Project {
  id: string;
  root: string;
  read_paths: string[];
  write_paths: string[];
  preview_path?: string;
  allow_overwrite: boolean;
  allow_destructive: boolean;
  allow_ui_capture: boolean;
  preview_delivery: 'local-only';
  cloud_recipients: string[];
  tasks?: TaskGrant[];
}
const protectedPart =
  /^(?:\.git|\.codex|\.agents|\.ssh|\.aws|\.azure|\.env(?:\..*)?|\.npmrc|\.pnpmfile\..*|node_modules)$/i;
const deniedName = /^(?:auth|credentials|secrets|config)\.(?:json|toml|ya?ml)$/i;
// Use the host path semantics consistently; never fold POSIX paths to lowercase.
// The optional flavor permits bounded Windows-path tests without a Windows host.
export function samePath(a: string, b: string, flavor = path): boolean {
  return flavor.relative(a, b) === '';
}
export function inside(root: string, candidate: string, flavor = path): boolean {
  const rel = flavor.relative(root, candidate);
  return (
    rel === '' || (!rel.startsWith(`..${flavor.sep}`) && rel !== '..' && !flavor.isAbsolute(rel))
  );
}
export function matchesGrantedPath(
  root: string,
  grants: string[],
  candidate: string,
  flavor = path
): boolean {
  return (
    inside(root, candidate, flavor) &&
    grants.some((p) => samePath(flavor.join(root, relativePath(p, flavor)), candidate, flavor))
  );
}
export function relativePath(value: unknown, flavor = path): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 2048 ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32) ||
    /[:*?"<>|]/.test(value) ||
    /^[\\/]/.test(value)
  )
    throw new Error('PATH_DENIED');
  const parts = value.replace(/\\/g, '/').split('/');
  if (
    parts.some(
      (p) =>
        !p ||
        p === '.' ||
        p === '..' ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p) ||
        protectedPart.test(p) ||
        deniedName.test(p)
    )
  )
    throw new Error('PATH_DENIED');
  return parts.join(flavor.sep);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}
export class ProjectPolicy {
  private projects = new Map<string, Project>();
  private filename?: string;
  private snapshot?: string;

  static async load(filename = process.env.PHOTOSHOP_PROJECTS_FILE): Promise<ProjectPolicy> {
    const policy = new ProjectPolicy();
    if (!filename) return policy;
    if (!path.isAbsolute(filename)) throw new Error('POLICY_FILE_MUST_BE_ABSOLUTE');
    policy.filename = await realpath(filename);
    if ((await lstat(filename)).isSymbolicLink()) throw new Error('POLICY_SYMLINK_DENIED');
    const raw = await readFile(policy.filename, 'utf8');
    if (raw.length > 1024 * 1024) throw new Error('POLICY_TOO_LARGE');
    const config = JSON.parse(raw);
    if (
      config.schema_version !== 1 ||
      !Array.isArray(config.projects) ||
      config.projects.length > 100
    )
      throw new Error('INVALID_POLICY');
    for (const item of config.projects) {
      if (
        !item ||
        typeof item.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) ||
        policy.projects.has(item.id) ||
        typeof item.root !== 'string' ||
        !path.isAbsolute(item.root) ||
        /^(?:\\\\|\/\/)/.test(item.root) ||
        !strings(item.read_paths) ||
        !strings(item.write_paths)
      )
        throw new Error('INVALID_PROJECT');
      for (const flag of ['allow_overwrite', 'allow_destructive', 'allow_ui_capture'])
        if (typeof item[flag] !== 'boolean') throw new Error('INVALID_PROJECT_FLAG');
      // No image delivery route is implemented. A caller cannot enable one.
      if (
        item.preview_delivery !== 'local-only' ||
        !Array.isArray(item.cloud_recipients) ||
        item.cloud_recipients.length
      )
        throw new Error('CLOUD_DELIVERY_UNSUPPORTED');
      const root = await realpath(item.root);
      if (!(await lstat(root)).isDirectory() || inside(root, policy.filename))
        throw new Error('POLICY_MUST_BE_OUTSIDE_PROJECTS');
      if ((await lstat(item.root)).isSymbolicLink() || !samePath(path.resolve(item.root), root))
        throw new Error('PROJECT_ALIAS_DENIED');
      for (const other of policy.projects.values())
        if (inside(other.root, root) || inside(root, other.root))
          throw new Error('OVERLAPPING_PROJECTS');
      const project = { ...item, root } as Project;
      for (const sub of [
        ...project.read_paths,
        ...project.write_paths,
        ...(project.preview_path ? [project.preview_path] : []),
      ]) {
        const full = path.join(root, relativePath(sub));
        await policy.noLinks(root, full);
        if (!(await lstat(full)).isDirectory()) throw new Error('ROOT_DIRECTORY_REQUIRED');
      }
      if (project.tasks !== undefined && !Array.isArray(project.tasks))
        throw new Error('INVALID_TASKS');
      const ids = new Set<string>();
      for (const task of project.tasks ?? []) {
        if (
          !task ||
          typeof task.id !== 'string' ||
          ids.has(task.id) ||
          !strings(task.tools) ||
          !strings(task.documents) ||
          typeof task.expires_at !== 'string' ||
          !Number.isFinite(Date.parse(task.expires_at))
        )
          throw new Error('INVALID_TASK');
        ids.add(task.id);
        if (task.allow_new_documents !== undefined && typeof task.allow_new_documents !== 'boolean')
          throw new Error('INVALID_TASK');
        if (task.destructive_tools !== undefined && !strings(task.destructive_tools))
          throw new Error('INVALID_TASK');
        if (task.overwrite_paths !== undefined && !strings(task.overwrite_paths))
          throw new Error('INVALID_TASK');
        if (task.output_paths !== undefined && !strings(task.output_paths))
          throw new Error('INVALID_TASK');
        for (const p of [
          ...task.documents,
          ...(task.overwrite_paths ?? []),
          ...(task.output_paths ?? []),
        ])
          relativePath(p);
      }
      policy.projects.set(project.id, project);
    }
    policy.snapshot = raw;
    return policy;
  }

  async unchanged(): Promise<void> {
    if (this.filename && (await readFile(this.filename, 'utf8')) !== this.snapshot)
      throw new Error('POLICY_CHANGED_RESTART_REQUIRED');
  }
  get(id: unknown): Project {
    if (typeof id !== 'string' || !this.projects.has(id)) throw new Error('PROJECT_NOT_REGISTERED');
    return this.projects.get(id)!;
  }
  list(): { id: string }[] {
    return [...this.projects.keys()].map((id) => ({ id }));
  }

  private async noLinks(root: string, full: string): Promise<void> {
    if (!inside(root, full)) throw new Error('PATH_DENIED');
    let current = root;
    for (const part of path.relative(root, full).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error('PATH_ALIAS_DENIED');
      const resolved = await realpath(current);
      if (!inside(root, resolved) || !samePath(path.resolve(current), resolved))
        throw new Error('PATH_ALIAS_DENIED');
    }
  }
  async resolve(
    project: Project,
    input: unknown,
    mode: 'read' | 'write',
    overwrite = false
  ): Promise<string> {
    await this.unchanged();
    if (
      (await realpath(project.root)) !== project.root ||
      (await lstat(project.root)).isSymbolicLink()
    )
      throw new Error('PROJECT_CHANGED');
    const rel = relativePath(input);
    const full = path.join(project.root, rel);
    const roots = mode === 'read' ? project.read_paths : project.write_paths;
    if (!roots.some((r) => inside(path.join(project.root, relativePath(r)), full)))
      throw new Error('PATH_DENIED');
    await this.noLinks(project.root, path.dirname(full));
    let exists = false;
    try {
      const stat = await lstat(full);
      exists = true;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error('FILE_ALIAS_DENIED');
      await this.noLinks(project.root, full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (mode === 'read' && !exists) throw new Error('INPUT_MISSING');
    if (mode === 'write' && exists && (!project.allow_overwrite || !overwrite))
      throw new Error('OVERWRITE_DENIED');
    const ext = path.extname(full).toLowerCase();
    if (!['.psd', '.png', '.jpg', '.jpeg'].includes(ext)) throw new Error('FORMAT_DENIED');
    return full;
  }
  async documentPath(project: Project, absolute: string): Promise<string> {
    if (!path.isAbsolute(absolute) || !inside(project.root, absolute))
      throw new Error('DOCUMENT_NOT_REGISTERED');
    const rel = path.relative(project.root, absolute);
    const full = await this.resolve(project, rel, 'read');
    if (!samePath(path.resolve(absolute), full)) throw new Error('DOCUMENT_PATH_MISMATCH');
    return full;
  }
  grant(
    project: Project,
    taskId: unknown,
    tool: string,
    document?: string,
    created = false,
    destructive = false
  ): TaskGrant {
    const grant = project.tasks?.find((g) => g.id === taskId);
    if (!grant || Date.now() >= Date.parse(grant.expires_at) || !grant.tools.includes(tool))
      throw new Error('TASK_NOT_AUTHORIZED');
    if (
      created
        ? !grant.allow_new_documents
        : !document || !matchesGrantedPath(project.root, grant.documents, document)
    )
      throw new Error('TASK_DOCUMENT_DENIED');
    if (destructive && (!project.allow_destructive || !grant.destructive_tools?.includes(tool)))
      throw new Error('DESTRUCTIVE_OPERATION_DENIED');
    return grant;
  }
}
