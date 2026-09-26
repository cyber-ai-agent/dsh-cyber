const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, session, shell } = require('electron')
const { mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const {
  assertRuntime, defaultStateRoot, runtimePaths, needsPreflightBackup,
  writeLaunchMarker, runBackup, launchHost, isAllowedOrigin, externalUrl,
} = require('./runtime.cjs')

const PRODUCT_NAME = 'DSH Cyber'
let window
let tray
let host
let origin
let stateRoot
let starting = true
let quitting = false
let shutdownDone = false
let shutdownInProgress = false
let quitAfterStart = false
let closeDecisionOpen = false
let quitDecisionOpen = false
let backgroundCloseConfirmed = false

if (process.platform !== 'win32') {
  app.quit()
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setAppUserModelId('com.dshcyber.desktop')
  app.on('second-instance', showWindow)
  app.on('activate', showWindow)
  app.on('before-quit', (event) => {
    if (shutdownDone) return
    event.preventDefault()
    if (starting) { quitAfterStart = true; return }
    if (shutdownInProgress) return
    shutdownInProgress = true
    quitting = true
    void Promise.resolve(host?.stop()).catch(() => undefined).finally(() => {
      shutdownDone = true
      app.quit()
    })
  })
  void app.whenReady().then(startDesktop).catch(async (error) => {
    dialog.showErrorBox('DSH Cyber 桌面版无法启动', describeError(error))
    starting = false
    app.quit()
  })
}

async function startDesktop() {
  const configuredDataRoot = process.env.DSH_CYBER_DESKTOP_DATA_DIR
  if (!app.isPackaged && !configuredDataRoot) throw new Error('开发模式必须使用隔离数据目录；请运行 pnpm desktop:dev')
  stateRoot = configuredDataRoot ? resolve(configuredDataRoot) : defaultStateRoot()
  const shellDataRoot = process.env.DSH_CYBER_DESKTOP_USER_DATA_DIR
    ? resolve(process.env.DSH_CYBER_DESKTOP_USER_DATA_DIR)
    : join(app.getPath('appData'), 'DSH Cyber Desktop')
  mkdirSync(shellDataRoot, { recursive: true })
  app.setPath('userData', shellDataRoot)
  const paths = runtimePaths({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, desktopRoot: __dirname })
  assertRuntime(paths)
  mkdirSync(stateRoot, { recursive: true })
  backgroundCloseConfirmed = require('node:fs').existsSync(join(app.getPath('userData'), 'background-close-confirmed'))
  createWindow(paths.icon)
  createTray(paths.icon)
  installMenu()
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (origin === undefined || details.resourceType !== 'mainFrame' || !isAllowedOrigin(details.url, origin)) {
      callback({})
      return
    }
    const headers = Object.fromEntries(Object.entries(details.responseHeaders || {}).filter(([key]) => key.toLowerCase() !== 'content-security-policy'))
    headers['Content-Security-Policy'] = [
      "default-src 'self' data: blob:",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' http: https: ws: wss:",
      "img-src 'self' data: blob: http: https:",
      "media-src 'self' data: blob:",
      "font-src 'self' data:",
      "worker-src 'self' blob:",
      "frame-src 'self' http: https:",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ')
    callback({ responseHeaders: headers })
  })
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const fromApp = origin !== undefined && isAllowedOrigin(details.requestingUrl, origin)
    callback(Boolean(fromApp && permission === 'media' && details.mediaTypes?.includes('audio')))
  })
  try {
    const marker = join(app.getPath('userData'), 'runtime-version.json')
    if (needsPreflightBackup(stateRoot, marker, app.getVersion())) {
      window.setTitle('DSH Cyber · 正在备份本地资料')
      await runBackup(paths, stateRoot)
    }
    if (quitAfterStart) return
    window.setTitle('DSH Cyber · 正在启动本地服务')
    host = launchHost(paths, stateRoot)
    origin = await host.originPromise
    host.exitedPromise.then(() => {
      if (starting || quitting) return
      dialog.showErrorBox('本地服务已停止', '桌面工作台与本地服务的连接已中断。应用将退出，原有资料不会删除。')
      app.quit()
    })
    if (quitAfterStart) return
    await window.loadURL(origin)
    writeLaunchMarker(stateRoot, marker, app.getVersion())
    window.setTitle(PRODUCT_NAME)
  } catch (error) {
    await host?.stop().catch(() => undefined)
    dialog.showErrorBox('DSH Cyber 桌面版无法启动', describeError(error))
    quitAfterStart = true
  } finally {
    starting = false
    if (quitAfterStart) app.quit()
  }
}

function createWindow(iconPath) {
  window = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#090d13',
    icon: iconPath,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false },
  })
  window.once('ready-to-show', () => window?.show())
  void window.loadFile(join(__dirname, 'startup.html'))
  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalUrl(url)
    if (external !== undefined && !isAllowedOrigin(external, origin)) void shell.openExternal(external)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (origin !== undefined && isAllowedOrigin(url, origin)) return
    event.preventDefault()
    const external = externalUrl(url)
    if (external !== undefined) void shell.openExternal(external)
  })
  window.on('close', (event) => {
    if (quitting || shutdownDone) return
    event.preventDefault()
    if (starting || closeDecisionOpen) return
    if (backgroundCloseConfirmed) { window.hide(); return }
    closeDecisionOpen = true
    void dialog.showMessageBox(window, {
      type: 'question',
      title: '保持后台运行',
      message: '关闭窗口后，DSH Cyber 会继续在后台运行。',
      detail: '进行中的任务和已启用的计划仍可继续。点击托盘图标可重新打开工作台；要完全停止，请从托盘选择“退出 DSH Cyber”。',
      buttons: ['留在后台', '取消'], defaultId: 0, cancelId: 1, noLink: true,
    }).then(({ response }) => {
      if (response !== 0 || !window || window.isDestroyed()) return
      mkdirSync(app.getPath('userData'), { recursive: true })
      require('node:fs').writeFileSync(join(app.getPath('userData'), 'background-close-confirmed'), '1\n')
      backgroundCloseConfirmed = true
      window.hide()
    }).catch(() => {
      dialog.showErrorBox('无法保留后台设置', '请检查桌面配置目录后重试；窗口仍保持打开。')
    }).finally(() => { closeDecisionOpen = false })
  })
  window.on('closed', () => { window = undefined })
}

function createTray(iconPath) {
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 24, height: 24 }))
  tray.setToolTip(PRODUCT_NAME)
  tray.on('click', showWindow)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 DSH Cyber', click: showWindow },
    { label: '打开数据目录', click: () => { if (stateRoot) void shell.openPath(stateRoot) } },
    { label: '查看备份', click: () => {
      if (!stateRoot) return
      const directory = join(stateRoot, 'backups')
      mkdirSync(directory, { recursive: true })
      void shell.openPath(directory)
    } },
    { type: 'separator' },
    { label: '退出 DSH Cyber', click: () => { void requestQuit() } },
  ]))
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'DSH Cyber', submenu: [
      { label: '显示工作台', click: showWindow },
      { type: 'separator' },
      { label: '退出 DSH Cyber', click: () => { void requestQuit() } },
    ] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }] },
  ]))
}

function showWindow() {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

async function requestQuit() {
  if (quitting || shutdownInProgress || quitDecisionOpen) return
  if (starting) { quitAfterStart = true; return }
  quitDecisionOpen = true
  try {
    const { response } = await dialog.showMessageBox({
      type: 'question', title: '退出 DSH Cyber？', message: '退出会停止本地服务。',
      detail: '正在运行的任务会中断；计划任务在应用关闭期间不会执行。本地世界、对话和资料会保留。',
      buttons: ['取消', '退出应用'], defaultId: 0, cancelId: 0, noLink: true,
    })
    if (response === 1) app.quit()
  } finally { quitDecisionOpen = false }
}

function describeError(error) {
  return error instanceof Error ? error.message : '请检查桌面运行时和本地数据目录后重试。'
}
