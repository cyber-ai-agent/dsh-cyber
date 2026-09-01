import { Cube, PuzzlePiece, X } from '@phosphor-icons/react'
import { useRef } from 'react'

import { useDialogFocusTrap } from '../../../components/useDialogFocusTrap.js'
import './WorldExtensionsDialog.css'

interface WorldExtensionsDialogProps {
  worldName: string
  spatialEnabled: boolean
  onSpatialEnabledChange(enabled: boolean): void
  onOpenSpatial(): void
  onClose(): void
}

/** Lightweight extension manager. It never imports the 3D runtime itself. */
export function WorldExtensionsDialog({ worldName, spatialEnabled, onSpatialEnabledChange, onOpenSpatial, onClose }: WorldExtensionsDialogProps) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocusTrap(dialogRef, onClose)

  return (
    <div className="modal-backdrop world-extensions-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="world-extensions-dialog" role="dialog" aria-modal="true" aria-labelledby="world-extensions-dialog-title">
        <header className="world-extensions-dialog__header">
          <span className="world-extensions-dialog__icon"><PuzzlePiece size={20} weight="fill" /></span>
          <div>
            <h2 id="world-extensions-dialog-title">世界扩展 · {worldName}</h2>
            <p>扩展不会改变核心世界。只有显式启用后才会加载额外运行时和资源。</p>
          </div>
          <button data-dialog-initial-focus type="button" className="icon-button" aria-label="关闭世界扩展" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="world-extensions-dialog__list">
          <article className={`world-extensions-dialog__card${spatialEnabled ? ' is-enabled' : ''}`}>
            <div className="world-extensions-dialog__card-icon"><Cube size={22} /></div>
            <div className="world-extensions-dialog__card-copy">
              <div className="world-extensions-dialog__card-title">
                <strong>3D 空间</strong>
                <span>{spatialEnabled ? '已启用' : '可选'}</span>
              </div>
              <p>独立的三维办公空间、VRM 角色和真实动作。关闭时不会探测 GPU、加载 Three.js、VRM 或 3D 角色资产。</p>
              <small>核心世界仍只使用平面地图和 2D 角色视图。</small>
            </div>
            <div className="world-extensions-dialog__actions">
              {spatialEnabled ? <>
                <button type="button" className="primary-button" onClick={onOpenSpatial}>打开 3D 空间</button>
                <button type="button" onClick={() => onSpatialEnabledChange(false)}>停用</button>
              </> : <button type="button" className="primary-button" onClick={() => onSpatialEnabledChange(true)}>启用扩展</button>}
            </div>
          </article>
        </div>
      </section>
    </div>
  )
}
