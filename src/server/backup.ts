import { sendEmails } from './email'
import { alertBucket, notifyAlertChat, type Alert } from './alerts'
import { adminAlerts } from './notifications'

// D1 每日备份：Cron（每 5 分钟）发现当天（UTC）还没有备份就导出一次，gzip 后存进 MEDIA 的 backups/d1/<日期>.sql.gz，
// 保留 BACKUP_RETENTION_DAYS 天。导出内容是建表语句加全部数据（sessions 只导结构），
// 恢复到空库：`node scripts/restore-d1.mjs`（见 README“数据备份”）。D1 自带的 Time Travel 只能回到 30 天内，
// 这份备份用于更久的留存、误删数据库或换账号迁移。
// 所有表的 SELECT 放在一个 db.batch 里执行：batch 是一个事务，拿到的是同一时刻的快照。
// backups/ 没有任何公开路由，/media/* 只读 templates/ 和 uploads/。

export const BACKUP_PREFIX = 'backups/d1/'
export const BACKUP_RETENTION_DAYS = 30
// 每天最多尝试几次：失败后下一次 Cron 重试，避免持续失败时每 5 分钟都跑一遍全表导出
const MAX_ATTEMPTS_PER_DAY = 3
// 只导结构不导数据的表：会话 token 哈希没有恢复价值，留在备份里只会增加泄露面
const SCHEMA_ONLY = new Set(['sessions'])

type SqlValue = string | number | null | ArrayBuffer | number[]

// SQLite 字面量。D1 把 BLOB 返回成数字数组
export function sqlLiteral(value: SqlValue | boolean | bigint | undefined): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : Uint8Array.from(value)
  return `X'${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}'`
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`

interface SchemaRow {
  type: 'table' | 'index' | 'trigger' | 'view'
  name: string
  tbl_name: string
  sql: string | null
}

export interface DumpResult {
  sql: string
  tables: number
  rows: number
}

export async function dumpDatabase(db: D1Database, now = new Date()): Promise<DumpResult> {
  // _cf_* 是 D1 内部表，sqlite_* 由 SQLite 维护；自动索引（sqlite_autoindex_*）没有 sql
  const schema = await db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid`,
    )
    .all<SchemaRow>()
  const tables = schema.results.filter((row) => row.type === 'table')
  const dataTables = tables.filter((table) => !SCHEMA_ONLY.has(table.name))
  const results = dataTables.length ? await db.batch(dataTables.map((table) => db.prepare(`SELECT * FROM ${ident(table.name)}`))) : []

  const lines = [`-- D1 backup ${now.toISOString()}`, 'PRAGMA defer_foreign_keys = true;']
  for (const table of tables) lines.push(`${table.sql};`)
  let rows = 0
  dataTables.forEach((table, i) => {
    for (const row of (results[i]?.results ?? []) as Array<Record<string, SqlValue>>) {
      const columns = Object.keys(row)
      lines.push(`INSERT INTO ${ident(table.name)} (${columns.map(ident).join(', ')}) VALUES (${columns.map((c) => sqlLiteral(row[c])).join(', ')});`)
      rows++
    }
  })
  // 索引、触发器、视图在数据之后建，导入更快
  for (const row of schema.results) if (row.type !== 'table') lines.push(`${row.sql};`)
  return { sql: `${lines.join('\n')}\n`, tables: tables.length, rows }
}

async function gzip(text: string) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const dayOf = (now: Date) => now.toISOString().slice(0, 10)
export const backupKey = (day: string) => `${BACKUP_PREFIX}${day}.sql.gz`

export interface BackupSummary {
  key: string
  tables: number
  rows: number
  bytes: number
  deleted: string[]
}

// 立即导出一次（覆盖当天已有的备份），并删除超过保留期的旧备份
export async function backupDatabase(env: Env, now = new Date()): Promise<BackupSummary> {
  const dump = await dumpDatabase(env.DB, now)
  const body = await gzip(dump.sql)
  const key = backupKey(dayOf(now))
  await env.MEDIA.put(key, body, {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: { tables: String(dump.tables), rows: String(dump.rows), createdAt: now.toISOString() },
  })
  const cutoff = backupKey(dayOf(new Date(now.getTime() - BACKUP_RETENTION_DAYS * 86400_000)))
  const deleted: string[] = []
  let cursor: string | undefined
  do {
    const page = await env.MEDIA.list({ prefix: BACKUP_PREFIX, cursor })
    // 键里的日期是 YYYY-MM-DD，按字符串比较即按日期比较
    for (const object of page.objects) if (object.key < cutoff) deleted.push(object.key)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  if (deleted.length) await env.MEDIA.delete(deleted)
  return { key, tables: dump.tables, rows: dump.rows, bytes: body.byteLength, deleted }
}

// Cron 入口：当天已有备份就跳过；失败记日志并按天给管理员发一次告警
export async function runDailyBackup(env: Env, now = new Date()) {
  const day = dayOf(now)
  if (await env.MEDIA.head(backupKey(day))) return null
  const attemptsKey = `backup:d1:attempts:${day}`
  const attempts = Number((await env.KV.get(attemptsKey)) ?? 0)
  if (attempts >= MAX_ATTEMPTS_PER_DAY) return null
  await env.KV.put(attemptsKey, String(attempts + 1), { expirationTtl: 2 * 86400 })
  try {
    const summary = await backupDatabase(env, now)
    console.log('[backup] d1', JSON.stringify(summary))
    return summary
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[alert] d1 backup failed', message)
    if (attempts + 1 >= MAX_ATTEMPTS_PER_DAY) {
      const alert: Alert = { kind: 'backup_failed', count: attempts + 1, total: null, windowMinutes: 24 * 60, detail: message.slice(0, 300) }
      await sendEmails(
        env,
        adminAlerts(env, `admin_alert:backup_failed:${day}`, () => ({
          template: 'admin_alert',
          params: alert,
        })),
      )
      await notifyAlertChat(env, alert, alertBucket(now.getTime()))
    }
    return null
  }
}
