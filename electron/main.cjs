/* ===========================================================================
 * MYRAA — Electron main process (Phase 1) & Cloud/Web Fallback
 * ---------------------------------------------------------------------------
 * Responsibilities:
 *   1. When running in Electron: Enforce single instance, launch backend,
 *      show splash window, create application window, handle lifecycle.
 *   2. When running in Web/Cloud/Render mode: Safely bypass Electron APIs
 *      without throwing errors, enabling pure Node.js cloud execution.
 * ========================================================================= */

'use strict';

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

// Safe Electron Detection:
// In Node.js non-Electron environments (e.g. Render / Cloud / Web servers),
// require('electron') returns a string path or stubs, and process.versions.electron is undefined.
let electron = null;
try {
  electron = require('electron');
} catch (e) {
  electron = null;
}

const isElectronRuntime = typeof process !== 'undefined' && process.versions && !!process.versions.electron;
const isElectronAvailable = isElectronRuntime && typeof electron === 'object' && electron !== null && !!electron.app;

if (!isElectronAvailable) {
  console.log('[MYRAA] Running in Production Web/Cloud mode (Electron runtime not detected).');
  // If executed directly by Node (e.g. node . or node electron/main.cjs), start the backend bundle if present
  const serverBundle = path.join(__dirname, '..', 'dist', 'server.cjs');
  if (require.main === module && fs.existsSync(serverBundle)) {
    console.log('[MYRAA Cloud] Launching server bundle directly...');
    require(serverBundle);
  }
} else {
  const { app, BrowserWindow, Menu, shell, dialog } = electron;

  // --- Constants -------------------------------------------------------------
  const SERVER_PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
  const SERVER_ORIGIN = `http://localhost:${SERVER_PORT}`;
  const SERVER_READY_TIMEOUT_MS = 40_000;

  // In development we run from the repo root; when packaged the app files live in
  // resources/app (asar-unpacked handling is added in the packaging phase).
  const APP_ROOT = app.isPackaged
    ? path.join(process.resourcesPath, 'app')
    : path.join(__dirname, '..');

  const SERVER_ENTRY = path.join(APP_ROOT, 'dist', 'server.cjs');

  /** @type {import('child_process').ChildProcess | null} */
  let serverProcess = null;
  /** @type {BrowserWindow | null} */
  let mainWindow = null;
  /** @type {BrowserWindow | null} */
  let splashWindow = null;
  let isQuitting = false;

  // ---------------------------------------------------------------------------
  // Single-instance guard — second launches focus the existing window instead of
  // starting a second backend on the same port.
  // ---------------------------------------------------------------------------
  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
    app.whenReady().then(bootstrap);
  }

  // ---------------------------------------------------------------------------
  // Backend lifecycle
  // ---------------------------------------------------------------------------
  function startBackend() {
    if (!fs.existsSync(SERVER_ENTRY)) {
      throw new Error(
        `Backend bundle not found at ${SERVER_ENTRY}. Run "npm run build" first.`,
      );
    }

    const dataDir = app.getPath('userData');

    const agentExe = app.isPackaged
      ? path.join(process.resourcesPath, 'agent', 'myraa-agent.exe')
      : path.join(APP_ROOT, 'agent_dist', 'myraa-agent', 'myraa-agent.exe');

    const env = {
      ...process.env,
      NODE_ENV: 'production',
      ELECTRON_RUN_AS_NODE: '1',
      MYRAA_LAUNCHED_BY: 'electron',
      MYRAA_DATA_DIR: dataDir,
      MYRAA_APP_ROOT: APP_ROOT,
    };
    if (fs.existsSync(agentExe)) {
      env.MYRAA_AGENT_EXE = agentExe;
    }

    serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: APP_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    serverProcess.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
    serverProcess.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
    serverProcess.on('exit', (code, signal) => {
      if (!isQuitting) {
        dialog.showErrorBox(
          'MYRAA backend stopped',
          `The MYRAA backend process exited unexpectedly (code ${code}, signal ${signal}).`,
        );
        app.quit();
      }
    });
  }

  function stopBackend() {
    if (serverProcess && !serverProcess.killed) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F']);
        } else {
          serverProcess.kill('SIGTERM');
        }
      } catch {
        /* best-effort */
      }
    }
    serverProcess = null;
  }

  /** Poll the backend until it answers, or reject on timeout. */
  function waitForBackend(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tryOnce = () => {
        const req = http.get(SERVER_ORIGIN, (res) => {
          res.resume();
          resolve();
        });
        req.on('error', () => {
          if (Date.now() > deadline) {
            reject(new Error('Backend did not become ready in time.'));
          } else {
            setTimeout(tryOnce, 400);
          }
        });
        req.setTimeout(2000, () => req.destroy());
      };
      tryOnce();
    });
  }

  // ---------------------------------------------------------------------------
  // Windows
  // ---------------------------------------------------------------------------
  function createSplashWindow() {
    splashWindow = new BrowserWindow({
      width: 420,
      height: 300,
      frame: false,
      transparent: true,
      resizable: false,
      center: true,
      show: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      backgroundColor: '#00000000',
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    splashWindow.loadFile(path.join(__dirname, 'splash.html'));
    splashWindow.on('closed', () => (splashWindow = null));
  }

  function createMainWindow() {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 940,
      minHeight: 600,
      show: false,
      backgroundColor: '#0a0a0f',
      autoHideMenuBar: true,
      title: 'MYRAA',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });

    Menu.setApplicationMenu(null);

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http') && !url.startsWith(SERVER_ORIGIN)) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
      return { action: 'allow' };
    });

    mainWindow.once('ready-to-show', () => {
      if (splashWindow) splashWindow.close();
      mainWindow?.show();
      mainWindow?.focus();
    });

    mainWindow.on('closed', () => (mainWindow = null));

    mainWindow.loadURL(SERVER_ORIGIN);
  }

  // ---------------------------------------------------------------------------
  // Bootstrap sequence
  // ---------------------------------------------------------------------------
  async function bootstrap() {
    app.setAppUserModelId('com.myraa.desktop');
    createSplashWindow();

    try {
      startBackend();
      await waitForBackend(SERVER_READY_TIMEOUT_MS);
      createMainWindow();
    } catch (err) {
      if (splashWindow) splashWindow.close();
      dialog.showErrorBox(
        'MYRAA failed to start',
        `${err instanceof Error ? err.message : String(err)}`,
      );
      app.quit();
    }
  }

  // ---------------------------------------------------------------------------
  // App lifecycle
  // ---------------------------------------------------------------------------
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopBackend();
  });

  process.on('exit', stopBackend);
}
