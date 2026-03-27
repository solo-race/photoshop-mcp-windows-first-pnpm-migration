import { execFile } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

export interface PhotoshopWindowInfo {
  title: string;
  automationId: string | null;
  className: string | null;
  processId: number;
  isEnabled: boolean;
  bounds: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  } | null;
}

export interface PhotoshopControlInfo {
  index: number;
  name: string;
  automationId: string | null;
  className: string | null;
  controlType: string | null;
  processId: number;
  isEnabled: boolean;
  bounds: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  } | null;
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function buildPayloadPrelude(payload: unknown): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload ?? {}), 'utf8').toString('base64');
  return `$payload = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPayload}')) | ConvertFrom-Json`;
}

const sharedPowerShellHelpers = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Get-PhotoshopWindows {
  $processes = Get-Process Photoshop -ErrorAction SilentlyContinue
  $pids = @($processes | ForEach-Object { $_.Id })
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $windows = @()

  for ($i = 0; $i -lt $children.Count; $i++) {
    $window = $children.Item($i)
    $windowPid = $window.Current.ProcessId
    $title = $window.Current.Name

    if (($pids -contains $windowPid) -or ($title -like '*Photoshop*')) {
      $rect = $window.Current.BoundingRectangle
      $bounds = $null
      if ($rect) {
        $bounds = [pscustomobject]@{
          left = [int]$rect.Left
          top = [int]$rect.Top
          right = [int]$rect.Right
          bottom = [int]$rect.Bottom
          width = [int]($rect.Right - $rect.Left)
          height = [int]($rect.Bottom - $rect.Top)
        }
      }

      $windows += [pscustomobject]@{
        title = $title
        automationId = $window.Current.AutomationId
        className = $window.Current.ClassName
        processId = $windowPid
        isEnabled = $window.Current.IsEnabled
        bounds = $bounds
      }
    }
  }

  return $windows
}

function Get-TargetPhotoshopWindow {
  param(
    [object]$Windows,
    [string]$TitleContains
  )

  if (-not $Windows -or $Windows.Count -eq 0) {
    return $null
  }

  if ($TitleContains) {
    foreach ($window in $Windows) {
      if ($window.title -like "*$TitleContains*") {
        return $window
      }
    }
  }

  return $Windows[0]
}
`;

export class WindowsUIController {
  private logger = new Logger('WindowsUIController');

  private async runPowerShell<T>(body: string, payload?: unknown): Promise<T> {
    const script = `${buildPayloadPrelude(payload)}\n${body}`.trim();
    const encoded = encodePowerShell(script);
    const { stdout, stderr } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encoded,
    ]);

    const trimmedStderr = stderr?.trim();
    if (
      trimmedStderr &&
      trimmedStderr.length > 0 &&
      !trimmedStderr.includes('Preparing modules for first use.')
    ) {
      this.logger.warn('PowerShell UI helper emitted stderr', trimmedStderr);
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      return {} as T;
    }

    return JSON.parse(trimmed) as T;
  }

  async listWindows(): Promise<{ total: number; windows: PhotoshopWindowInfo[] }> {
    return await this.runPowerShell(
      `
${sharedPowerShellHelpers}
$windows = Get-PhotoshopWindows
@{
  total = $windows.Count
  windows = $windows
} | ConvertTo-Json -Depth 8 -Compress
      `
    );
  }

  async listControls(
    titleContains?: string,
    limit = 80
  ): Promise<{ window: PhotoshopWindowInfo | null; total: number; controls: PhotoshopControlInfo[] }> {
    return await this.runPowerShell(
      `
${sharedPowerShellHelpers}
$windows = Get-PhotoshopWindows
$target = Get-TargetPhotoshopWindow -Windows $windows -TitleContains $payload.titleContains

if (-not $target) {
  @{
    window = $null
    total = 0
    controls = @()
  } | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
  [int]$target.processId
)
$children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
$windowElement = $null

for ($i = 0; $i -lt $children.Count; $i++) {
  if ($children.Item($i).Current.Name -eq $target.title) {
    $windowElement = $children.Item($i)
    break
  }
}

if (-not $windowElement) {
  @{
    window = $target
    total = 0
    controls = @()
  } | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

$descendants = $windowElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$controls = @()
$max = [Math]::Min([int]$payload.limit, $descendants.Count)

for ($index = 0; $index -lt $max; $index++) {
  $control = $descendants.Item($index)
  $rect = $control.Current.BoundingRectangle
  $bounds = $null
  if ($rect) {
    $bounds = [pscustomobject]@{
      left = [int]$rect.Left
      top = [int]$rect.Top
      right = [int]$rect.Right
      bottom = [int]$rect.Bottom
      width = [int]($rect.Right - $rect.Left)
      height = [int]($rect.Bottom - $rect.Top)
    }
  }

  $controls += [pscustomobject]@{
    index = $index + 1
    name = $control.Current.Name
    automationId = $control.Current.AutomationId
    className = $control.Current.ClassName
    controlType = $control.Current.ControlType.ProgrammaticName
    processId = $control.Current.ProcessId
    isEnabled = $control.Current.IsEnabled
    bounds = $bounds
  }
}

@{
  window = $target
  total = $controls.Count
  controls = $controls
} | ConvertTo-Json -Depth 10 -Compress
      `,
      {
        titleContains,
        limit,
      }
    );
  }

  async focusWindow(titleContains?: string): Promise<Record<string, unknown>> {
    return await this.runPowerShell(
      `
$shell = New-Object -ComObject WScript.Shell
$process = Get-Process Photoshop -ErrorAction SilentlyContinue | Select-Object -First 1
$activated = $false

if ($payload.titleContains) {
  $activated = $shell.AppActivate([string]$payload.titleContains)
} elseif ($process) {
  $activated = $shell.AppActivate([int]$process.Id)
}

@{
  focused = [bool]$activated
} | ConvertTo-Json -Depth 4 -Compress
      `,
      {
        titleContains,
      }
    );
  }

  async sendShortcut(
    keys: string,
    originalShortcut: string,
    titleContains?: string
  ): Promise<Record<string, unknown>> {
    return await this.runPowerShell(
      `
$shell = New-Object -ComObject WScript.Shell
$process = Get-Process Photoshop -ErrorAction SilentlyContinue | Select-Object -First 1

if ($payload.titleContains) {
  $null = $shell.AppActivate([string]$payload.titleContains)
} elseif ($process) {
  $null = $shell.AppActivate([int]$process.Id)
}

Start-Sleep -Milliseconds 150
$shell.SendKeys([string]$payload.keys)

@{
  sent = $true
  keys = $payload.originalShortcut
  sendKeys = $payload.keys
} | ConvertTo-Json -Depth 4 -Compress
      `,
      {
        keys,
        originalShortcut,
        titleContains,
      }
    );
  }

  async waitForDialog(
    titleContains?: string,
    timeoutMs = 5000
  ): Promise<{ detected: boolean; window: PhotoshopWindowInfo | null; waitedMs: number }> {
    return await this.runPowerShell(
      `
${sharedPowerShellHelpers}
$deadline = (Get-Date).AddMilliseconds([int]$payload.timeoutMs)

while ((Get-Date) -lt $deadline) {
  $windows = Get-PhotoshopWindows
  foreach ($window in $windows) {
    if ($window.className -eq '#32770' -or ($payload.titleContains -and $window.title -like "*$($payload.titleContains)*")) {
      @{
        detected = $true
        window = $window
        waitedMs = [int]([DateTimeOffset](Get-Date)).ToUnixTimeMilliseconds()
      } | ConvertTo-Json -Depth 8 -Compress
      exit 0
    }
  }

  Start-Sleep -Milliseconds 200
}

@{
  detected = $false
  window = $null
  waitedMs = [int]$payload.timeoutMs
} | ConvertTo-Json -Depth 8 -Compress
      `,
      {
        titleContains,
        timeoutMs,
      }
    );
  }

  async captureWindowSnapshot(
    titleContains?: string,
    outputPath?: string,
    includeBase64 = false
  ): Promise<Record<string, unknown>> {
    return await this.runPowerShell(
      `
${sharedPowerShellHelpers}
Add-Type -AssemblyName System.Drawing

$windows = Get-PhotoshopWindows
$target = Get-TargetPhotoshopWindow -Windows $windows -TitleContains $payload.titleContains

if (-not $target -or -not $target.bounds) {
  throw 'No Photoshop window available to capture.'
}

$path = $payload.outputPath
if (-not $path) {
  $path = Join-Path ([System.IO.Path]::GetTempPath()) ('photoshop-window-' + [guid]::NewGuid().ToString() + '.png')
}

$width = [int]$target.bounds.width
$height = [int]$target.bounds.height
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen([int]$target.bounds.left, [int]$target.bounds.top, 0, 0, $bitmap.Size)
$bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()

$result = [ordered]@{
  title = $target.title
  processId = $target.processId
  path = $path
  width = $width
  height = $height
}

if ($payload.includeBase64) {
  $result.base64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($path))
}

$result | ConvertTo-Json -Depth 8 -Compress
      `,
      {
        titleContains,
        outputPath,
        includeBase64,
      }
    );
  }

  async getUiSnapshot(titleContains?: string): Promise<Record<string, unknown>> {
    const windows = await this.listWindows();
    const controls = await this.listControls(titleContains);

    return {
      windows,
      controls,
    };
  }
}

export function toSendKeys(shortcut: string): string {
  const normalized = shortcut
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  const parts = normalized.split('+').filter(Boolean);

  if (parts.length === 0) {
    return '';
  }

  const modifiers = new Set(parts.slice(0, -1));
  const mainKey = parts[parts.length - 1];
  let prefix = '';

  if (modifiers.has('ctrl') || modifiers.has('control')) {
    prefix += '^';
  }
  if (modifiers.has('shift')) {
    prefix += '+';
  }
  if (modifiers.has('alt')) {
    prefix += '%';
  }

  const specialMap: Record<string, string> = {
    enter: '{ENTER}',
    escape: '{ESC}',
    esc: '{ESC}',
    tab: '{TAB}',
    delete: '{DELETE}',
    backspace: '{BACKSPACE}',
    space: ' ',
    left: '{LEFT}',
    right: '{RIGHT}',
    up: '{UP}',
    down: '{DOWN}',
    f1: '{F1}',
    f2: '{F2}',
    f3: '{F3}',
    f4: '{F4}',
    f5: '{F5}',
    f6: '{F6}',
    f7: '{F7}',
    f8: '{F8}',
    f9: '{F9}',
    f10: '{F10}',
    f11: '{F11}',
    f12: '{F12}',
  };

  const mappedKey = specialMap[mainKey] ?? mainKey;
  return `${prefix}${mappedKey}`;
}
