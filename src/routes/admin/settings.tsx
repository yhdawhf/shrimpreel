import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent } from 'react'
import { AdminPage, LoadState, shortDate, useAdminData } from '#/components/admin'
import { Spinner, StatusPill } from '#/components/ui'
import { api, errorCode } from '#/lib/api'

export const Route = createFileRoute('/admin/settings')({
  component: AdminSettings,
})

type Field =
  | { key: string; kind: 'bool'; label: string; help: string }
  | { key: string; kind: 'int'; label: string; help: string; min: number; max: number }
  | { key: string; kind: 'text'; label: string; help: string; maxLength: number }
  | { key: string; kind: 'select'; label: string; help: string; options: Array<{ value: string; label: string }> }
type Value = boolean | number | string
type Data = {
  fields: Field[]
  values: Record<string, Value>
  defaults: Record<string, Value>
  overrides: Array<{ key: string; updatedAt: string; updatedBy: string | null }>
}
type ProbeResult = { target: string; provider: string; status: 'ok' | 'warn' | 'fail' | 'skipped'; message: string; ms: number }

const PROBES = [
  { target: 'storage', label: 'R2 存储', help: '写入、读取、删除一个临时对象' },
  { target: 'kv', label: 'KV', help: '写入、读取、删除一个临时键' },
  { target: 'email', label: '发信', help: '给你的邮箱发一封测试邮件' },
  { target: 'payment', label: '支付', help: '只读查询：鉴权，Dodo 另核对每个套餐的商品和价格；不建收银台' },
  { target: 'video', label: '视频生成', help: '只读查询：鉴权和账户余额；不提交任务' },
  { target: 'moderation', label: '图片审核', help: '只读查询：鉴权和审核模型是否可用' },
] as const

const PROBE_TONE = { ok: 'ok', warn: 'warn', fail: 'bad', skipped: 'muted' } as const
const PROBE_LABEL = { ok: '正常', warn: '注意', fail: '失败', skipped: '未启用' } as const

const toInput = (value: Value) => (typeof value === 'boolean' ? value : String(value))
const defaultLabel = (field: Field, value: Value) =>
  field.kind === 'select' ? (field.options.find((option) => option.value === value)?.label ?? String(value)) : String(value) || '空'
const sameValue = (field: Field, input: Value, value: Value) => (field.kind === 'int' ? Number(input) === value : input === value)

// 运营设置：不改代码就能调的非敏感参数（存 D1，KV 缓存约 60 秒生效），以及各外部服务的连接测试。密钥不在这里管理
function AdminSettings() {
  const { data, error, loading, reload } = useAdminData<Data>('/api/admin/settings')
  const [form, setForm] = useState<Record<string, Value>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [probes, setProbes] = useState<Record<string, ProbeResult | 'running'>>({})

  useEffect(() => {
    if (data) setForm(Object.fromEntries(Object.entries(data.values).map(([key, value]) => [key, toInput(value)])))
  }, [data])

  const changed = data ? data.fields.filter((field) => form[field.key] !== undefined && !sameValue(field, form[field.key]!, data.values[field.key]!)) : []

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!changed.length) return
    const summary = changed.map((field) => `${field.label}：${String(data!.values[field.key])} → ${String(form[field.key])}`).join('\n')
    if (!confirm(`保存以下修改？约 60 秒内全站生效。\n\n${summary}`)) return
    setBusy(true)
    setMessage(null)
    try {
      const values = Object.fromEntries(changed.map((field) => [field.key, field.kind === 'int' ? Number(form[field.key]) : form[field.key]]))
      await api('/api/admin/settings', { json: { values } })
      setMessage({ tone: 'ok', text: `已保存 ${changed.length} 项` })
      await reload()
    } catch (err) {
      const detail = err instanceof Error && err.message !== errorCode(err) ? err.message : errorCode(err)
      setMessage({ tone: 'bad', text: `保存失败：${detail}` })
    } finally {
      setBusy(false)
    }
  }

  async function probe(target: string) {
    setProbes((p) => ({ ...p, [target]: 'running' }))
    try {
      const result = await api<ProbeResult>(`/api/admin/probes/${target}`, { json: {} })
      setProbes((p) => ({ ...p, [target]: result }))
    } catch (err) {
      setProbes((p) => ({ ...p, [target]: { target, provider: '', status: 'fail', message: errorCode(err), ms: 0 } }))
    }
  }

  const overrides = new Map(data?.overrides.map((row) => [row.key, row]))

  return (
    <AdminPage title="运营设置">
      <LoadState loading={loading && !data} error={error} />
      {data ? (
        <form onSubmit={save} className="card space-y-5 p-5 text-sm" data-testid="settings-form">
          <p className="text-xs text-muted">保存后写入数据库，前台读取有约 60 秒缓存。密钥（支付、视频、审核、发信）仍在 wrangler secrets 里管理。</p>
          <div className="grid gap-5 md:grid-cols-2">
            {data.fields.map((field) => {
              const override = overrides.get(field.key)
              const value = form[field.key]
              const isDefault = value !== undefined && sameValue(field, value, data.defaults[field.key]!)
              const locked = field.kind === 'int' && field.max === field.min
              return (
                <div key={field.key} className="space-y-1" data-testid="setting-field" data-key={field.key}>
                  {field.kind === 'bool' ? (
                    <label className="flex items-center gap-2 font-medium">
                      <input type="checkbox" checked={value === true} onChange={(e) => setForm((f) => ({ ...f, [field.key]: e.target.checked }))} data-testid={`setting-${field.key}`} />
                      {field.label}
                    </label>
                  ) : field.kind === 'select' ? (
                    <label className="block space-y-1">
                      <span className="font-medium">{field.label}</span>
                      <select
                        className="input"
                        value={String(value ?? '')}
                        onChange={(e) => setForm((f) => ({ ...f, [field.key]: e.target.value }))}
                        data-testid={`setting-${field.key}`}
                      >
                        {field.options.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label className="block space-y-1">
                      <span className="font-medium">{field.label}</span>
                      <input
                        className="input"
                        type={field.kind === 'int' ? 'number' : 'text'}
                        {...(field.kind === 'int' ? { min: field.min, max: field.max, step: 1, required: true } : { maxLength: field.maxLength })}
                        disabled={locked}
                        value={String(value ?? '')}
                        onChange={(e) => setForm((f) => ({ ...f, [field.key]: e.target.value }))}
                        data-testid={`setting-${field.key}`}
                      />
                    </label>
                  )}
                  <p className="text-xs text-muted">{field.help}</p>
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    {override ? <span>{`已修改：${override.updatedBy ?? '—'} · ${shortDate(override.updatedAt)}`}</span> : <span>使用默认值</span>}
                    {!isDefault && !locked ? (
                      <button type="button" className="underline" onClick={() => setForm((f) => ({ ...f, [field.key]: toInput(data.defaults[field.key]!) }))}>
                        {`恢复默认（${defaultLabel(field, data.defaults[field.key]!)}）`}
                      </button>
                    ) : null}
                  </p>
                </div>
              )
            })}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="btn-primary" disabled={busy || !changed.length} data-testid="settings-save">
              {busy ? <Spinner /> : null}
              {changed.length ? `保存 ${changed.length} 项修改` : '没有修改'}
            </button>
            {message ? (
              <span role={message.tone === 'bad' ? 'alert' : 'status'} className={message.tone === 'bad' ? 'text-red-600 dark:text-red-400' : 'text-muted'} data-testid="settings-message">
                {message.text}
              </span>
            ) : null}
          </div>
        </form>
      ) : null}

      <section className="card space-y-3 p-5 text-sm" data-testid="probes">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-medium">测试连接</h2>
            <p className="text-xs text-muted">按当前环境的配置逐项探测，结果不含密钥。改了 secrets 或服务商后台配置后跑一遍。</p>
          </div>
          <button type="button" className="btn-ghost" onClick={() => PROBES.forEach((p) => void probe(p.target))} data-testid="probe-all">
            全部测试
          </button>
        </div>
        <ul className="divide-y divide-line">
          {PROBES.map((p) => {
            const result = probes[p.target]
            return (
              <li key={p.target} className="flex flex-wrap items-start gap-3 py-3" data-testid="probe-row" data-target={p.target}>
                <div className="min-w-48 flex-1">
                  <p className="font-medium">{p.label}</p>
                  <p className="text-xs text-muted">{p.help}</p>
                </div>
                <div className="min-w-64 flex-[2] space-y-1" data-testid="probe-result">
                  {result === 'running' ? (
                    <Spinner />
                  ) : result ? (
                    <>
                      <p className="flex items-center gap-2">
                        <StatusPill tone={PROBE_TONE[result.status]}>{PROBE_LABEL[result.status]}</StatusPill>
                        <span className="text-xs text-muted">{[result.provider, result.ms ? `${result.ms} ms` : ''].filter(Boolean).join(' · ')}</span>
                      </p>
                      <p className="break-words text-xs">{result.message}</p>
                    </>
                  ) : null}
                </div>
                <button type="button" className="btn-ghost" disabled={result === 'running'} onClick={() => void probe(p.target)} data-testid="probe-run">
                  测试
                </button>
              </li>
            )
          })}
        </ul>
      </section>
    </AdminPage>
  )
}
