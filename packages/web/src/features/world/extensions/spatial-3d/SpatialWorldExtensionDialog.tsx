import { ArrowsOut, Cube, Minus, Plus, X } from '@phosphor-icons/react'
import { useMemo, useRef, useState } from 'react'
import type { WorldCue, WorldRuntimeSnapshot, WorldThemeManifestV1, WorldZoomCommand } from '@dsh-cyber/contracts'

import { useDialogFocusTrap } from '../../../../components/useDialogFocusTrap.js'
import type { CyberEmployee } from '../../../../types.js'
import type { WorldLocomotion } from '../../runtime/world-locomotion.js'
import type { WorldCameraMode } from '../../runtime/world-view-mode.js'
import { createZoomCommand } from '../../zoom-command.js'
import { SpatialWorldCanvas } from './SpatialWorldCanvas.js'
import './SpatialWorldExtensionDialog.css'

interface SpatialWorldExtensionDialogProps {
  worldName: string
  manifest: WorldThemeManifestV1
  locomotion: WorldLocomotion
  rendererIdentity: string
  snapshot: WorldRuntimeSnapshot
  cues: WorldCue[]
  employees: CyberEmployee[]
  selectedEmployeeId?: string
  selectedObjectId?: string
  onSelectEmployee(employeeId: string): void
  onSelectObject(objectId: string): void
  onClose(): void
}

const CAMERA_LABELS: Record<WorldCameraMode, string> = {
  overview: '全景',
  focus: '聚焦',
  follow: '跟随',
}

export function SpatialWorldExtensionDialog({
  worldName,
  manifest,
  locomotion,
  rendererIdentity,
  snapshot,
  cues,
  employees,
  selectedEmployeeId,
  selectedObjectId,
  onSelectEmployee,
  onSelectObject,
  onClose,
}: SpatialWorldExtensionDialogProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const [cameraMode, setCameraMode] = useState<WorldCameraMode>(selectedEmployeeId === undefined ? 'overview' : 'focus')
  const [subjectId, setSubjectId] = useState<string | undefined>(selectedEmployeeId)
  const [fitRequest, setFitRequest] = useState(0)
  const [zoomCommand, setZoomCommand] = useState<WorldZoomCommand>()
  useDialogFocusTrap(dialogRef, onClose)

  const firstAgentId = useMemo(() => snapshot.entities.find((entity) => entity.kind === 'agent')?.id, [snapshot.entities])
  const setCamera = (mode: WorldCameraMode) => {
    if (mode === 'overview') {
      setCameraMode('overview')
      setSubjectId(undefined)
      return
    }
    const subject = subjectId ?? selectedEmployeeId ?? firstAgentId
    if (subject === undefined) return
    setSubjectId(subject)
    setCameraMode(mode)
    onSelectEmployee(subject)
  }
  const selectEmployee = (employeeId: string) => {
    setSubjectId(employeeId)
    if (cameraMode === 'overview') setCameraMode('focus')
    onSelectEmployee(employeeId)
  }

  return (
    <div className="modal-backdrop spatial-world-extension-backdrop" role="presentation">
      <section ref={dialogRef} className="spatial-world-extension" role="dialog" aria-modal="true" aria-labelledby="spatial-world-extension-title">
        <header className="spatial-world-extension__header">
          <div className="spatial-world-extension__identity">
            <span><Cube size={20} weight="fill" /></span>
            <div>
              <h2 id="spatial-world-extension-title">3D 空间扩展 · {worldName}</h2>
              <p>独立可选视图。关闭后核心平面地图继续原样运行，不保留 WebGL 上下文。</p>
            </div>
          </div>
          <div className="spatial-world-extension__camera" role="tablist" aria-label="3D 镜头">
            {(['overview', 'focus', 'follow'] as const).map((mode) => <button key={mode} type="button" role="tab" aria-selected={cameraMode === mode} className={cameraMode === mode ? 'is-active' : ''} disabled={mode !== 'overview' && firstAgentId === undefined} onClick={() => setCamera(mode)}>{CAMERA_LABELS[mode]}</button>)}
          </div>
          <button data-dialog-initial-focus type="button" className="icon-button" aria-label="关闭 3D 空间扩展" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="spatial-world-extension__stage">
          <SpatialWorldCanvas
            manifest={manifest}
            locomotion={locomotion}
            rendererIdentity={rendererIdentity}
            snapshot={snapshot}
            cues={cues}
            employees={employees}
            cameraMode={cameraMode}
            {...(subjectId === undefined ? {} : { cameraSubjectId: subjectId })}
            {...(selectedEmployeeId === undefined ? {} : { selectedEntityId: selectedEmployeeId })}
            {...(selectedObjectId === undefined ? {} : { selectedObjectId })}
            fitRequest={fitRequest}
            {...(zoomCommand === undefined ? {} : { zoomCommand })}
            onEntitySelect={selectEmployee}
            onObjectSelect={onSelectObject}
          />
          <div className="spatial-world-extension__controls" aria-label="3D 空间视图控制">
            <button type="button" aria-label="缩小 3D 空间" onClick={() => setZoomCommand(createZoomCommand(-0.1))}><Minus size={15} /></button>
            <button type="button" aria-label="3D 空间显示全景" onClick={() => { setCameraMode('overview'); setSubjectId(undefined); setFitRequest((value) => value + 1) }}><ArrowsOut size={15} /></button>
            <button type="button" aria-label="放大 3D 空间" onClick={() => setZoomCommand(createZoomCommand(0.1))}><Plus size={15} /></button>
          </div>
        </div>
      </section>
    </div>
  )
}
