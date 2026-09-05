/**
 * Typed Artifact，第一层（存储与校验）。
 *
 * AgentTeams 任务输出目前是无结构的字符串：会被截断、没有结构、下游也难以
 * 验证来源。本模块把任务产出升级为一等公民「Typed Artifact」：任务完成时产出
 * 结构化资产（requirements / code_diff / test_report / security_report / ...），
 * 每条记录携带 schema、uri、sha256、contentType、sizeBytes、生产者（host /
 * member）与 attempt 归属；落盘为
 * `<stateRoot>/.agent-teams/<teamId>/artifacts/<id>.json`，文件体为
 * `{ record, content }`。
 *
 * 未来接线点（本模块不实现）：
 * - 任务完成时把字符串 output 升级为 {@link ArtifactRef}（createArtifactRef），
 *   并将 ref 挂到任务状态（state.ts）的任务产出上；
 * - 下游任务入参只传 artifact ref + schema，不传长文本本体；需要内容时按
 *   ref.uri / artifactId 通过 readArtifactFile 按需取回。
 *
 * 依赖约束：只使用 node: 内置模块（node:crypto / node:fs/promises /
 * node:path），不 import 任何 @deepseek-ai/* 包，也不 import 项目内其他模块
 * （如 state.ts / types.ts），类型全部自带，保证独立可测。
 * @module dsh-agent-teams/artifacts
 */

import { createHash, randomBytes } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** 任务可以产出的一等 Typed Artifact 类型。 */
export type ArtifactKind =
  | 'requirements'
  | 'decision'
  | 'code_diff'
  | 'test_report'
  | 'security_report'
  | 'benchmark'
  | 'research_report'
  | 'design'
  | 'release_package'
  | 'generic'

/** 一条落盘的 artifact 记录：元数据 + 内容寻址，不含 content 本体。 */
export interface ArtifactRecord {
  /** 稳定唯一 id，形如 `art-<ts>-<6位hex>`。 */
  id: string
  /** 创建时间，epoch 毫秒。 */
  ts: number
  /** 所属团队 id。 */
  teamId: string
  /** 产出该 artifact 的任务 id。 */
  taskId: string
  /** 产出该 artifact 的 attempt id；无 attempt 环境（如决策）可缺省。 */
  attemptId?: string
  /** artifact 类型。 */
  kind: ArtifactKind
  /** 可选 schema 标识（URL 或名），供下游做结构校验。 */
  schema?: string
  /** 相对引用路径，约定 `.agent-teams/<teamId>/artifacts/<id>.json`。 */
  uri: string
  /** content 的 SHA-256（UTF-8 字节）hex 摘要，用于内容寻址与防篡改。 */
  sha256: string
  /** content 的 MIME 类型，例如 `application/json`。 */
  contentType: string
  /** content 的 UTF-8 字节数。 */
  sizeBytes: number
  /** 短文摘要，供下游在不读正文的情况下理解该 artifact。 */
  summary: string
  /** 生产者：host（任务框架侧）或 member（成员 agent 侧）。 */
  producer: 'host' | 'member'
  /** 来源任务 id；当 artifact 由成员产出、但归属于宿主任务时使用。 */
  sourceTaskId?: string
}

/** 传给下游任务的引用：只带定位与校验信息，不含大内容。 */
export interface ArtifactRef {
  /** 指向的 artifact 记录 id。 */
  artifactId: string
  /** artifact 类型。 */
  kind: ArtifactKind
  /** 可选 schema 标识，与 record.schema 一致。 */
  schema?: string
  /** 相对引用路径，与 record.uri 一致。 */
  uri: string
  /** content 的 SHA-256，与 record.sha256 一致。 */
  sha256: string
  /** 短文摘要，与 record.summary 一致。 */
  summary: string
}

/** 创建 artifact 的输入：除 id/ts/uri/sha256/sizeBytes 外均为调用方提供。 */
export interface NewArtifactInput {
  /** 所属团队 id。 */
  teamId: string
  /** 产出任务的 id（任务完成时即为该任务）。 */
  taskId: string
  /** 产出 attempt id；可缺省。 */
  attemptId?: string
  /** artifact 类型。 */
  kind: ArtifactKind
  /** 可选 schema 标识（URL 或名）。 */
  schema?: string
  /** content 的 MIME 类型。 */
  contentType: string
  /** artifact 正文（直接以字符串提供；可为 JSON 文本或纯文本）。 */
  content: string
  /** 短文摘要。 */
  summary: string
  /** 生产者：host 或 member。 */
  producer: 'host' | 'member'
  /** 来源任务 id；可缺省。 */
  sourceTaskId?: string
}

/** 计算 content 的 SHA-256 摘要（UTF-8 编码），hex 字符串。 */
export function hashArtifactSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** 由输入生成一条完整 {@link ArtifactRecord}；id 缺省为 `art-<ts>-<6位hex>`。 */
export function computeArtifactRecord(input: NewArtifactInput, id?: string): ArtifactRecord {
  const artifactId = id ?? `art-${Date.now()}-${randomBytes(3).toString('hex')}`
  return {
    id: artifactId,
    ts: Date.now(),
    teamId: input.teamId,
    taskId: input.taskId,
    kind: input.kind,
    uri: artifactFileBlueprint(input.teamId, artifactId).relativePath,
    sha256: hashArtifactSha256(input.content),
    contentType: input.contentType,
    sizeBytes: Buffer.byteLength(input.content, 'utf8'),
    summary: input.summary,
    producer: input.producer,
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    ...(input.schema !== undefined ? { schema: input.schema } : {}),
    ...(input.sourceTaskId !== undefined ? { sourceTaskId: input.sourceTaskId } : {}),
  }
}

/** 把记录升级为传给下游任务的轻量引用；taskId 必须与 record.taskId 一致。 */
export function createArtifactRef(record: ArtifactRecord, taskId: string): ArtifactRef {
  if (record.taskId !== taskId) {
    throw new Error(
      `createArtifactRef: taskId ${taskId} does not match record.taskId ${record.taskId}`,
    )
  }
  return {
    artifactId: record.id,
    kind: record.kind,
    uri: record.uri,
    sha256: record.sha256,
    summary: record.summary,
    ...(record.schema !== undefined ? { schema: record.schema } : {}),
  }
}

/** artifact 落盘文件的命名约定：文件名与相对路径（相对 stateRoot）。 */
export function artifactFileBlueprint(
  teamId: string,
  artifactId: string,
): { fileName: string; relativePath: string } {
  return {
    fileName: `${artifactId}.json`,
    relativePath: `.agent-teams/${teamId}/artifacts/${artifactId}.json`,
  }
}

/** 任一 artifact 文件在 team 状态目录下的目标路径。
 * `stateRoot` 是 `<workspace>/<stateDir>` 的解析根（已含状态目录名），
 * 因此这里只接 teamId/artifacts 段；uri 里的 `.agent-teams/` 是相对
 * workspace 的展示路径，绝不能再拼进 stateRoot（曾造成双重目录）。 */
function artifactPath(stateRoot: string, teamId: string, artifactId: string): string {
  return join(stateRoot, teamId, 'artifacts', `${artifactId}.json`)
}

/** rename 的 Windows 重试封装：EPERM（目标被临时占用）最多重试两次。 */
async function renameAtomic(from: string, to: string): Promise<void> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
      if (code !== 'EPERM') throw err
      lastErr = err
      // Windows 上 rename 遇 EPERM（杀毒/索引器等临时占用）属于瞬时故障，稍后重试。
      await new Promise((r) => setTimeout(r, 10 * (attempt + 1)))
    }
  }
  throw lastErr
}

/**
 * 原子写入 artifact：先写同目录临时文件，再 rename 到目标路径。
 * 返回写入文件的绝对路径。
 */
export async function writeArtifactFile(
  stateRoot: string,
  record: ArtifactRecord,
  content: string,
): Promise<string> {
  const target = artifactPath(stateRoot, record.teamId, record.id)
  await mkdir(dirname(target), { recursive: true })
  const tmp = join(dirname(target), `.${record.id}.${randomBytes(4).toString('hex')}.tmp`)
  await writeFile(tmp, JSON.stringify({ record, content }), 'utf8')
  try {
    await renameAtomic(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  return resolve(target)
}

/** 读取 artifact 文件；不存在返回 undefined，损坏（缺 record/content）抛错。 */
export async function readArtifactFile(
  stateRoot: string,
  teamId: string,
  artifactId: string,
): Promise<{ record: ArtifactRecord; content: string } | undefined> {
  let raw: string
  try {
    raw = await readFile(artifactPath(stateRoot, teamId, artifactId), 'utf8')
  } catch (err) {
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
    if (code === 'ENOENT') return undefined
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `readArtifactFile: corrupt artifact ${artifactId}: invalid JSON (${(err as Error).message})`,
    )
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || !('record' in parsed)
    || !('content' in parsed)
  ) {
    throw new Error(`readArtifactFile: corrupt artifact ${artifactId}: expected { record, content }`)
  }
  const { record, content } = parsed as { record: ArtifactRecord; content: string }
  return { record, content }
}

/** 删除 artifact 文件；不存在也不报错（force）。 */
export async function deleteArtifactFile(
  stateRoot: string,
  teamId: string,
  artifactId: string,
): Promise<void> {
  await rm(artifactPath(stateRoot, teamId, artifactId), { force: true })
}

/**
 * 列出某团队的全部 artifact id。
 * 目录不存在返回 []; 忽略以 `.` 开头的文件（隐藏文件、临时文件）与非 `.json` 文件。
 */
export async function listArtifactIds(stateRoot: string, teamId: string): Promise<string[]> {
  const dir = join(stateRoot, teamId, 'artifacts')
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
    if (code === 'ENOENT') return []
    throw err
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.') && e.name.endsWith('.json'))
    .map((e) => e.name.slice(0, -'.json'.length))
    .sort()
}
