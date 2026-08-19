import {
  Browser,
  CaretDoubleRight,
  File,
  FileCode,
  FileText,
  GlobeHemisphereWest,
  IdentificationBadge,
  Image,
  MagnifyingGlass,
} from '@phosphor-icons/react'
import { useState } from 'react'
import type { EmployeeDossier as EmployeeDossierData } from '@dsh-cyber/contracts'

import type { CyberEmployee, DockTab } from '../types.js'
import { EmployeeDossier } from './EmployeeDossier.js'
import { WorldView } from './WorldView.js'

interface ArtifactDockProps {
  activeTab: DockTab
  selectedEmployee?: CyberEmployee
  dossier?: EmployeeDossierData
  employees: CyberEmployee[]
  worldName: string
  onTabChange(tab: DockTab): void
  onCollapse(): void
  onSelectEmployee(employeeId: string): void
  onDirectEmployee(employee: CyberEmployee): void
}

const tabs: Array<{ id: DockTab; label: string; icon: typeof File }> = [
  { id: 'files', label: '文件', icon: File },
  { id: 'preview', label: '预览', icon: Image },
  { id: 'browser', label: '浏览器', icon: Browser },
  { id: 'world', label: '世界', icon: GlobeHemisphereWest },
  { id: 'dossier', label: '档案', icon: IdentificationBadge },
]

export function ArtifactDock({
  activeTab,
  selectedEmployee,
  dossier,
  employees,
  worldName,
  onTabChange,
  onCollapse,
  onSelectEmployee,
  onDirectEmployee,
}: ArtifactDockProps) {
  const [browserUrl, setBrowserUrl] = useState('https://www.deepseek.com/harness/')
  const [loadedUrl, setLoadedUrl] = useState(browserUrl)

  return (
    <section className="artifact-dock" aria-label="产物与世界侧边栏">
      <header className="dock-tabs">
        <nav aria-label="侧边栏工具">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                type="button"
                className={activeTab === tab.id ? 'is-active' : ''}
                onClick={() => onTabChange(tab.id)}
              >
                <Icon size={15} />
                <span>{tab.label}</span>
              </button>
            )
          })}
        </nav>
        <button className="icon-button" type="button" aria-label="收起侧边栏" onClick={onCollapse}>
          <CaretDoubleRight size={17} />
        </button>
      </header>

      <div className="dock-content">
        {activeTab === 'world' ? (
          <WorldView worldName={worldName} employees={employees} onSelectEmployee={onSelectEmployee} />
        ) : null}
        {activeTab === 'dossier' ? (
          dossier !== undefined && selectedEmployee !== undefined
            ? <EmployeeDossier
                dossier={dossier}
                employees={employees}
                avatarIndex={selectedEmployee.avatarIndex}
                onDirect={() => onDirectEmployee(selectedEmployee)}
              />
            : <DockEmpty icon={IdentificationBadge} title="选择一名员工" copy="从通讯录或世界中打开员工数字档案。" />
        ) : null}
        {activeTab === 'files' ? <FileBrowser /> : null}
        {activeTab === 'preview' ? <ArtifactPreview /> : null}
        {activeTab === 'browser' ? (
          <div className="embedded-browser">
            <form onSubmit={(event) => { event.preventDefault(); setLoadedUrl(normalizeUrl(browserUrl)) }}>
              <MagnifyingGlass size={15} />
              <input value={browserUrl} onChange={(event) => setBrowserUrl(event.target.value)} aria-label="浏览器地址" />
              <button type="submit">打开</button>
            </form>
            <iframe
              key={loadedUrl}
              src={loadedUrl}
              title="内置浏览器"
              sandbox="allow-forms allow-scripts allow-same-origin allow-popups"
              referrerPolicy="no-referrer"
            />
            <p>部分站点会阻止嵌入，可在新窗口打开。</p>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function FileBrowser() {
  const files = [
    ['v0.3.0-架构设计.md', '1.2 MB', FileText],
    ['审计日志建表.sql', '3.4 KB', FileCode],
    ['告警规则配置.yaml', '2.1 KB', FileCode],
    ['安全扫描报告.html', '128 KB', GlobeHemisphereWest],
    ['发布计划看板.png', '256 KB', Image],
  ] as const
  return (
    <div className="file-browser">
      <header><strong>世界产物</strong><span>{files.length} 项</span></header>
      <div className="file-list">
        {files.map(([name, size, Icon]) => (
          <button key={name} type="button">
            <Icon size={20} />
            <span><strong>{name}</strong><small>{size} · 10:38 更新</small></span>
          </button>
        ))}
      </div>
    </div>
  )
}

function ArtifactPreview() {
  return (
    <article className="artifact-preview">
      <header><FileText size={20} /><div><strong>v0.3.0-架构设计.md</strong><span>由老周提交 · 10:33</span></div></header>
      <h2>v0.3.0 发布架构</h2>
      <p>本方案覆盖租户隔离、审计日志和告警规则三条主链路，并为每一条链路定义可复现的验收方法。</p>
      <h3>验收边界</h3>
      <ul><li>租户数据不可越权访问</li><li>审计事件可查询并具备完整来源</li><li>告警规则支持去重与恢复</li></ul>
      <pre><code>tenant → policy → audit → alert</code></pre>
    </article>
  )
}

function DockEmpty({ icon: Icon, title, copy }: { icon: typeof File; title: string; copy: string }) {
  return <div className="dock-empty"><Icon size={30} /><strong>{title}</strong><p>{copy}</p></div>
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

