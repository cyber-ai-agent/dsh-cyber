import { lazy, Suspense, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from '@phosphor-icons/react'
import type { Workspace } from '@dsh-cyber/contracts'

import { useI18n } from '../../i18n/runtime.js'
import { useDialogFocusTrap } from '../../components/useDialogFocusTrap.js'

const IntegrationSettingsPanel = lazy(async () => ({ default: (await import('./IntegrationSettingsPanel.js')).IntegrationSettingsPanel }))

/**
 * Top-level "connection hub" dialog, sibling to the model hub. Owns the
 * encrypted connection store (SSH devices, API endpoints, Firecrawl/MCP) and
 * is where characters get connection-level grants in later milestones.
 */
export function ConnectionHubDialog({ workspace, onClose }: { workspace: Workspace; onClose(): void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(true)
  const panelRef = useRef<HTMLElement>(null)
  useDialogFocusTrap(panelRef, () => { setOpen(false); onClose() })
  if (!open) return null
  return createPortal(<div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { setOpen(false); onClose() } }}>
    <section ref={panelRef} className="connection-hub" role="dialog" aria-modal="true" aria-labelledby="connection-hub-title">
      <header className="connection-hub__header">
        <div>
          <h2 id="connection-hub-title"><span className="connection-hub__glyph">⌁</span> {t('connectionHub.title', '连接中心')}</h2>
          <p>{t('connectionHub.subtitle', '统一管理受信任的连接：SSH 设备、API 端点等。凭据只在本机加密保存；角色仍需授权并逐动作审批。')}</p>
        </div>
        <button type="button" className="icon-button" aria-label={t('connectionHub.close', '关闭连接中心')} data-dialog-initial-focus onClick={() => { setOpen(false); onClose() }}><X size={18} /></button>
      </header>
      <Suspense fallback={<div className="connection-hub__loading">{t('connectionHub.loading', '加载连接中心…')}</div>}>
        <IntegrationSettingsPanel workspaceId={workspace.id} />
      </Suspense>
    </section>
  </div>, document.body)
}
